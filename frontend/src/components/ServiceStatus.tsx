import { useEffect, useState } from 'react'
import { getHealth, HealthError } from '../lib/api'

type ConnectionState =
  | { kind: 'checking' }
  | { kind: 'connected' }
  | { kind: 'unavailable'; message: string }

export default function ServiceStatus() {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ConnectionState>({ kind: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => {
      if (!active) return
      active = false
      controller.abort()
      setState({ kind: 'unavailable', message: 'Connection timed out. Try again.' })
    }, 5000)

    getHealth(controller.signal)
      .then(() => {
        if (active) setState({ kind: 'connected' })
      })
      .catch((error: unknown) => {
        if (active) setState({
          kind: 'unavailable',
          message: error instanceof HealthError ? error.message : 'Could not check the connection.',
        })
      })
      .finally(() => {
        active = false
        window.clearTimeout(timeout)
      })

    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [attempt])

  function checkConnection() {
    setState({ kind: 'checking' })
    setAttempt((previous) => previous + 1)
  }

  const label = state.kind === 'checking' ? 'Checking connection…'
    : state.kind === 'connected' ? 'Connected' : 'Unavailable'

  return (
    <section className="dashboard-service" aria-labelledby="service-status-title">
      <div>
        <h2 id="service-status-title">Service status</h2>
        <div role="status" aria-live="polite" aria-atomic="true">
          <p className={`dashboard-service-state dashboard-service-${state.kind}`}>{label}</p>
          <p className="dashboard-service-detail">{state.kind === 'unavailable'
            ? `${state.message} You can still explore the demo.`
            : 'API connection only. Portfolio and watchlist values remain sample data.'}</p>
        </div>
      </div>
      <button type="button" disabled={state.kind === 'checking'} onClick={checkConnection}>
        {state.kind === 'unavailable' ? 'Retry' : 'Check connection'}
      </button>
    </section>
  )
}
