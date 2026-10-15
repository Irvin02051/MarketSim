"""Read-only quote evidence and deterministic calculations; no model or HTTP layer."""

from decimal import Decimal, localcontext
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.market_data import MarketData, Quote, QuoteError, normalize_symbol


class QuotesInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, revalidate_instances='always')
    symbols: list[str] = Field(min_length=1, max_length=3)

    @field_validator('symbols')
    @classmethod
    def validate_symbols(cls, symbols: list[str]) -> list[str]:
        try:
            normalized = [normalize_symbol(symbol) for symbol in symbols]
        except QuoteError as error:
            raise ValueError(error.detail) from None
        if len(set(normalized)) != len(normalized):
            raise ValueError('Symbols must be unique after normalization.')
        return normalized


class Evidence(BaseModel):
    id: str
    quote: Quote
    fictional: bool


class SymbolError(BaseModel):
    symbol: str
    status: int
    message: str


class PriceRange(BaseModel):
    evidence_id: str
    value: Decimal
    currency: str


class PercentageDifference(BaseModel):
    # Operand order matches the requested symbol order.
    evidence_ids: tuple[str, str]
    value: Decimal
    unit: Literal['percentage_points'] = 'percentage_points'


class RankGroup(BaseModel):
    # Dense ranking: equal changes share a rank and an explicit group.
    rank: int
    evidence_ids: list[str]
    change_percent: Decimal
    tied: bool


class Calculations(BaseModel):
    origin: Literal['backend'] = 'backend'
    ranges: list[PriceRange]
    difference: PercentageDifference | None = None
    ranking: list[RankGroup] | None = None


class QuotesResult(BaseModel):
    requested_symbols: list[str]
    evidence: list[Evidence]
    errors: list[SymbolError]
    data_mode: Literal['fictional', 'provider_backed', 'mixed', 'unavailable']
    label: str
    calculations: Calculations
    limitations: list[str]


def subtract(left: float, right: float) -> Decimal:
    """Use decimal representations of validated floats, not their binary expansions.

    Decimal values serialize as strings. Precision covers the full finite float
    exponent range so subtraction does not depend on ambient decimal settings.
    """
    with localcontext() as context:
        context.prec = 650
        return Decimal(str(left)) - Decimal(str(right))


async def get_quotes(service: MarketData, request: QuotesInput | dict[str, object]) -> QuotesResult:
    """Validate everything before calling the existing service once per symbol.

    Expected QuoteError failures become fixed safe messages. Unexpected failures
    propagate to the caller rather than being misreported as provider failures.
    """
    validated = QuotesInput.model_validate(request)
    evidence: list[Evidence] = []
    errors: list[SymbolError] = []
    safe_messages = {
        400: 'Invalid quote request.',
        404: 'Quote unavailable for this symbol.',
        429: 'Quote request budget or provider quota reached.',
        502: 'Provider could not supply valid quote data.',
        503: 'Quote service is not configured or unavailable.',
        504: 'Quote request timed out.',
    }
    for symbol in validated.symbols:
        try:
            quote = await service.get_quote(symbol)
        except QuoteError as error:
            errors.append(SymbolError(
                symbol=symbol, status=error.status,
                message=safe_messages.get(error.status, 'Quote retrieval failed.'),
            ))
            continue
        evidence.append(Evidence(
            id=f'q{len(evidence) + 1}', quote=quote,
            fictional=quote.source == 'demo' or quote.data_kind == 'fictional',
        ))

    fictional = sum(item.fictional for item in evidence)
    if not evidence:
        mode, label = 'unavailable', 'No quote evidence available.'
    elif fictional == len(evidence):
        mode, label = 'fictional', 'FICTIONAL DEMO DATA — not live market observations.'
    elif fictional:
        mode, label = 'mixed', 'Contains FICTIONAL DEMO DATA; sources are mixed.'
    else:
        mode, label = 'provider_backed', 'Provider-backed quotes; real-time freshness is not verified.'

    calculations = Calculations(ranges=[
        PriceRange(evidence_id=item.id, value=subtract(item.quote.high, item.quote.low),
                   currency=item.quote.currency)
        for item in evidence
    ])
    limitations = ['Fetch time does not establish market-data freshness.']
    if fictional:
        limitations.append('Fictional values cannot establish actual market performance.')
    if len(validated.symbols) > 1:
        if errors:
            limitations.append('Cross-stock comparisons omitted: not all requested quotes succeeded.')
        elif len({item.quote.latest_trading_day for item in evidence}) != 1:
            limitations.append('Cross-stock comparisons omitted: trading dates differ.')
        else:
            if len(evidence) == 2:
                first, second = evidence
                calculations.difference = PercentageDifference(
                    evidence_ids=(first.id, second.id),
                    value=subtract(first.quote.change_percent, second.quote.change_percent),
                )
            groups: dict[Decimal, list[str]] = {}
            for item in evidence:
                groups.setdefault(Decimal(str(item.quote.change_percent)), []).append(item.id)
            calculations.ranking = [
                RankGroup(rank=rank, evidence_ids=groups[value], change_percent=value,
                          tied=len(groups[value]) > 1)
                for rank, value in enumerate(sorted(groups, reverse=True), start=1)
            ]
    return QuotesResult(
        requested_symbols=validated.symbols, evidence=evidence, errors=errors,
        data_mode=mode, label=label, calculations=calculations, limitations=limitations,
    )
