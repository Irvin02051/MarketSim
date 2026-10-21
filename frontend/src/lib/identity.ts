export type Identity = { user_id: string }
export type IdentityCode = 'authentication' | 'unavailable' | 'configuration' | 'network' | 'timeout' | 'malformed' | 'mismatch'
export const identityMessages: Record<IdentityCode, string> = {
  authentication: 'Your session was not accepted. Please log in again.',
  unavailable: 'Backend identity verification is unavailable. Please try again later.',
  configuration: 'The authentication or backend address configuration is unavailable.',
  network: 'Could not reach the identity service. Check your connection and try again.',
  timeout: 'Identity verification timed out. Please try again.',
  malformed: 'The identity service returned an invalid response. Please try again later.',
  mismatch: 'Backend identity verification failed. Please log in again before retrying.',
}
export class IdentityError extends Error {
  code: IdentityCode
  constructor(code: IdentityCode) { super(identityMessages[code]); this.code = code }
}
type SessionAccess = { getSession: () => Promise<{
  data: { session: { access_token: string; user: { id: string } } | null }; error: unknown
}> }

// Same VITE_API_BASE_URL setting/path-prefix convention as the public API helpers,
// but token-bearing requests require HTTPS except these explicit loopback hosts.
export function identityUrl(base: unknown): string {
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    const url = new URL(base.trim())
    if (url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/me`
    return url.href
  } catch { throw new IdentityError('configuration') }
}

/** Ten-second total deadline covers SDK session acquisition, fetch and body reading. */
export async function requestIdentity(base: unknown, auth: SessionAccess | null, expectedUser: string,
  signal: AbortSignal, timeoutMs = 10000): Promise<Identity> {
  const url = identityUrl(base)
  if (!auth) throw new IdentityError('configuration')
  const controller = new AbortController()
  let rejectAbort: (reason: unknown) => void = () => {}
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => {
    controller.abort()
    rejectAbort(new DOMException('Request cancelled', 'AbortError'))
  }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
    rejectAbort(new IdentityError('timeout'))
  }, timeoutMs)
  const work = async () => {
    controller.signal.throwIfAborted()
    const { data, error } = await auth.getSession()
    controller.signal.throwIfAborted()
    if (error) throw new IdentityError('unavailable')
    const session = data.session
    if (!session) throw new IdentityError('authentication')
    if (session.user.id !== expectedUser) throw new IdentityError('mismatch')
    if (!session.access_token || !/^[A-Za-z0-9._~+/-]+=*$/.test(session.access_token)
      || session.access_token.length > 8185) throw new IdentityError('authentication')
    const response = await fetch(url, { method: 'GET', signal: controller.signal,
      headers: { Authorization: `Bearer ${session.access_token}` },
      credentials: 'omit', cache: 'no-store', redirect: 'error' })
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new IdentityError('network')
    if (response.status === 401) throw new IdentityError('authentication')
    if (response.status === 503) throw new IdentityError('unavailable')
    if (response.status !== 200) throw new IdentityError('unavailable')
    let value: unknown
    try { value = await response.json() } catch { throw new IdentityError('malformed') }
    controller.signal.throwIfAborted()
    if (typeof value !== 'object' || value === null || !('user_id' in value)
      || typeof value.user_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.user_id)) {
      throw new IdentityError('malformed')
    }
    if (value.user_id.toLowerCase() !== expectedUser.toLowerCase()) throw new IdentityError('mismatch')
    return { user_id: value.user_id }
  }
  try {
    if (signal.aborted) abort()
    return await Promise.race([interrupted, work()])
  } catch (error) {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (error instanceof IdentityError) throw error
    throw new IdentityError('network')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export type CheckState = { status: 'idle' | 'loading' | 'verified' } | { status: 'error'; code: IdentityCode }
/** Component-owned gate and cancellation. No automatic requests or retries. */
export function createIdentityCheck(run: (signal: AbortSignal) => Promise<Identity>, publish: (state: CheckState) => void) {
  let pending: AbortController | null = null
  return {
    async start() {
      if (pending) return
      const controller = new AbortController()
      pending = controller
      publish({ status: 'loading' })
      try {
        await run(controller.signal)
        if (!controller.signal.aborted) publish({ status: 'verified' })
      } catch (error) {
        if (!controller.signal.aborted) publish({ status: 'error', code: error instanceof IdentityError ? error.code : 'network' })
      } finally { if (pending === controller) pending = null }
    },
    cancel() { pending?.abort(); pending = null },
  }
}
