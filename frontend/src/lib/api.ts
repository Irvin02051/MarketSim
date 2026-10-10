export type HealthResponse = { status: 'ok'; service: 'marketsim-api' }

export class HealthError extends Error {}

function healthUrl(): string {
  const base: unknown = import.meta.env.VITE_API_BASE_URL
  if (typeof base !== 'string' || !base.trim()) {
    throw new HealthError('API address is not configured.')
  }
  try {
    const url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid base URL')
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/health`
    return url.href
  } catch {
    throw new HealthError('API address is invalid.')
  }
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const url = healthUrl()
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal, credentials: 'omit', cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new HealthError('Could not reach the API.')
  }
  if (!response.ok) throw new HealthError('API health check failed.')
  let data: unknown
  try {
    data = await response.json()
  } catch (error) {
    if (signal?.aborted) throw error
    throw new HealthError('API returned an invalid response.')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || !('status' in data) || data.status !== 'ok'
    || !('service' in data) || data.service !== 'marketsim-api') {
    throw new HealthError('API returned an invalid response.')
  }
  return { status: data.status, service: data.service }
}
