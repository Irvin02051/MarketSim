import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatHistoryDate, utcDate } from '../lib/history'
import type { ChartHistory } from '../lib/history'

export default function HistoryChart({ result }: { result: ChartHistory }) {
  const description = result.source === 'demo' ? 'fictional daily closing prices' : 'Alpha Vantage end-of-day unadjusted closing prices'
  if (!result.bars.length) return <p>No observations in this range.</p>
  const points = result.bars.map((bar) => ({ time: utcDate(bar.date), close: bar.close }))
  const first = utcDate(result.requested_range.start), last = utcDate(result.requested_range.end)
  return <>
    <p>Closing price (USD) · Date (UTC)</p>
    <div className="history-chart" aria-label={`${result.symbol} ${description}. Data table follows.`}>
      <ResponsiveContainer width="100%" height={320} minWidth={0}>
        <LineChart data={points} margin={{ top: 16, right: 24, bottom: 28, left: 4 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="time" type="number" scale="time"
            domain={first === last ? [first - 86400000, last + 86400000] : [first, last]}
            tickFormatter={(time) => new Date(time).toISOString().slice(5, 10)}
            minTickGap={35} label={{ value: 'Date (UTC)', position: 'insideBottom', offset: -18 }} />
          <YAxis width={80} domain={['auto', 'auto']} tickFormatter={(value) => `$${value.toFixed(2)}`} />
          <Tooltip labelFormatter={(value) => formatHistoryDate(Number(value))}
            formatter={(value) => [`$${Number(value).toFixed(2)} USD`, 'Close']} />
          <Line dataKey="close" name="Close (USD)" type="linear" stroke="#176b51" strokeWidth={2}
            dot={points.length === 1 ? { r: 5 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <p className="history-note">Lines connect reported observations; intermediate prices are not observations. These are not current quotes.</p>
    <details className="history-table"><summary>View closing-price data table ({points.length} observations)</summary>
      <table><caption>{result.symbol} {description} in USD</caption>
        <thead><tr><th scope="col">Date (UTC)</th><th scope="col">Close (USD)</th></tr></thead>
        <tbody>{result.bars.map((bar) => <tr key={bar.date}><td>{bar.date}</td><td>${bar.close.toFixed(2)}</td></tr>)}</tbody>
      </table>
    </details>
  </>
}
