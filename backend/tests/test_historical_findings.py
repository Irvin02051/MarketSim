import unittest
from datetime import date
from decimal import Decimal

from pydantic import ValidationError

from app.historical_data import DateRange
from app.historical_findings import (
    AgentReply,
    HistoricalFinding,
    render_historical_findings,
)
from app.historical_metrics import OUTPUT_QUANTUM
from app.historical_research import get_historical_metrics
from app.research_explanation import ModelFailure


class HistoricalFindingTests(unittest.TestCase):
    def setUp(self):
        self.evidence = list(get_historical_metrics({
            'symbols': ['AAPL', 'MSFT'], 'start_date': date(2025, 1, 1), 'end_date': date(2025, 3, 31),
        }).evidence)

    def selection(self, *, metric='price_change', ids=None, relation='higher'):
        return HistoricalFinding(metric=metric, evidence_ids=ids or ['hm1', 'hm2'], relation=relation)

    def render(self, finding=None, evidence=None):
        return render_historical_findings([finding or self.selection()],
                                          self.evidence if evidence is None else evidence)[0]

    def test_all_single_metrics_render_only_backend_values_windows_and_labels(self):
        for key in ['price_change', 'sma_20', 'sma_50', 'adjacent_return_volatility_20']:
            item = self.render(self.selection(metric=key, ids=['hm1'], relation='reported'))
            metric = getattr(self.evidence[0], key)
            self.assertIn(str(metric.value), item.statement)
            self.assertIn(str(metric.window.start), item.statement)
            self.assertIn(str(metric.window.end), item.statement)
            self.assertIn(f'{metric.observation_count} observations', item.statement)
            self.assertIn(metric.unit, item.statement)
            self.assertIn('FICTIONAL DEMO DATA', item.statement)
            self.assertIn('Adjustment basis unknown', item.statement)
            self.assertEqual(item.statement_origin, 'backend')

    def test_pairwise_relations_and_interpretations(self):
        self.assertIn('higher than', self.render().statement)
        self.assertIn('lower than', self.render(self.selection(ids=['hm2', 'hm1'], relation='lower')).statement)
        sma = self.render(self.selection(metric='sma_50', relation='lower')).statement
        self.assertIn('Nominal price levels do not establish better performance', sma)
        volatility = self.render(self.selection(metric='adjacent_return_volatility_20',
                                                ids=['hm2', 'hm1'], relation='lower')).statement
        self.assertIn('measured return variability, not overall safety', volatility)
        self.assertIn('not annualized', volatility)

    def test_equal_serialized_values_cannot_support_higher_or_lower(self):
        # Different unrounded values collapse to the same authoritative six places.
        rounded = [Decimal('1.0000001').quantize(OUTPUT_QUANTUM),
                   Decimal('1.0000002').quantize(OUTPUT_QUANTUM)]
        evidence = [item.model_copy(update={'price_change': item.price_change.model_copy(update={'value': value})})
                    for item, value in zip(self.evidence, rounded, strict=True)]
        self.assertEqual([e.model_dump(mode='json')['price_change']['value'] for e in evidence],
                         ['1.000000', '1.000000'])
        self.assertIn('equal to', self.render(self.selection(relation='equal'), evidence).statement)
        for relation in ['higher', 'lower']:
            with self.assertRaises(ModelFailure):
                self.render(self.selection(relation=relation), evidence)

    def test_invalid_references_duplicates_and_wrong_relations(self):
        for ids, relation in [(['q1'], 'reported'), (['hm1', 'missing'], 'higher'),
                              (['hm1', 'hm1'], 'equal'), (['hm1'], 'higher'),
                              (['hm1', 'hm2'], 'reported'), (['hm1', 'hm2'], 'lower')]:
            with self.subTest(ids=ids, relation=relation), self.assertRaises(ModelFailure):
                self.render(self.selection(ids=ids, relation=relation))
        with self.assertRaises(ModelFailure):
            render_historical_findings([self.selection(), self.selection()], self.evidence)

    def test_unavailable_metrics_never_become_zero_findings(self):
        for end in [date(2025, 1, 1), date(2025, 1, 3)]:
            evidence = list(get_historical_metrics({
                'symbols': ['AAPL', 'MSFT'], 'start_date': date(2025, 1, 1), 'end_date': end,
            }).evidence)
            self.assertIsNone(evidence[0].sma_20.value)
            for ids, relation in [(['hm1'], 'reported'), (['hm1', 'hm2'], 'higher')]:
                with self.assertRaises(ModelFailure):
                    self.render(self.selection(metric='sma_20', ids=ids, relation=relation), evidence)

    def test_same_requested_range_does_not_allow_incompatible_actual_metrics(self):
        right = self.evidence[1]
        for changes in [
            {'window': DateRange(start=date(2025, 1, 2), end=date(2025, 3, 31))},
            {'unit': 'USD'}, {'observation_count': right.price_change.observation_count - 1},
            {'required_observations': 3},
        ]:
            changed = right.model_copy(update={'price_change': right.price_change.model_copy(update=changes)})
            with self.subTest(changes=changes), self.assertRaises(ModelFailure):
                self.render(evidence=[self.evidence[0], changed])

    def test_mismatched_provenance_and_return_counts_rejected(self):
        right = self.evidence[1]
        # Synthetic incompatible records exercise the compatibility boundary;
        # production evidence comes only from the typed, demo-only wrapper.
        for field, value in [('source', 'other'), ('data_kind', 'live'), ('currency', 'EUR'),
                             ('adjustment_basis', 'adjusted'), ('interval', 'weekly'),
                             ('observation_calendar', 'exchange'), ('fixture_range', None)]:
            changed = right.model_copy(update={'provenance': right.provenance.model_copy(update={field: value})})
            with self.subTest(field=field), self.assertRaises(ModelFailure):
                self.render(evidence=[self.evidence[0], changed])
        with self.assertRaises(ModelFailure):
            self.render(self.selection(metric='adjacent_return_volatility_20'),
                        [self.evidence[0], right.model_copy(update={'volatility_return_count': 19})])

    def test_different_requested_ranges_can_share_an_actual_metric_window(self):
        left = get_historical_metrics({'symbols': ['AAPL'], 'start_date': date(2025, 1, 4),
                                       'end_date': date(2025, 3, 31)}).evidence[0]
        right = get_historical_metrics({'symbols': ['MSFT'], 'start_date': date(2025, 1, 5),
                                        'end_date': date(2025, 3, 31)}).evidence[0].model_copy(update={'id': 'hm2'})
        self.assertNotEqual(left.provenance.requested_range, right.provenance.requested_range)
        self.assertEqual(left.price_change.window, right.price_change.window)
        self.assertIn('2025-01-06', self.render(evidence=[left, right]).statement)

    def test_schema_rejects_model_numbers_prose_and_unknown_metrics(self):
        valid = self.selection().model_dump()
        for change in [{'metric': 'momentum'}, {'value': '999'}, {'statement': 'buy'},
                       {'relation': 'bullish'}, {'evidence_ids': ['hm1', 'hm2', 'hm3']}]:
            with self.subTest(change=change), self.assertRaises(ValidationError):
                AgentReply.model_validate({'status': 'answered', 'findings': [],
                                          'historical_findings': [valid | change]})


if __name__ == '__main__':
    unittest.main()
