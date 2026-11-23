import { useEffect, useState } from 'react'
import type { DiscoveredHistoryResult } from '../lib/history'
import { createDiscoveredMetricsController } from '../lib/historyMetrics'
import type { HistoryMetricsState } from '../lib/historyMetrics'
import { RawPriceStatistics } from './RealHistoryMetrics'

// The history result subtree is removed on dates, selection, search or reload.
export default function DiscoveredHistoryMetrics({ reference, history, base }: {
  reference: string; history: DiscoveredHistoryResult; base: unknown
}) {
  const [state, setState] = useState<HistoryMetricsState>({ kind: 'idle' })
  const [controller] = useState(() => createDiscoveredMetricsController(reference, history, setState))
  useEffect(() => () => controller.cancel(), [controller])
  return <RawPriceStatistics state={state} load={() => { void controller.load(base) }} />
}
