import { createClient } from '@supabase/supabase-js'
import type { Session, SupabaseClient, User } from '@supabase/supabase-js'

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: Session; user: User }
  | { status: 'unavailable' }

type Configuration = { VITE_SUPABASE_URL?: unknown; VITE_SUPABASE_PUBLISHABLE_KEY?: unknown }
export type AuthClient = Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange'>

// A getter keeps SDK initialization outside React rendering and creates only one client.
export function createAuthClientGetter(
  configuration: Configuration,
  storage: () => Storage = () => window.sessionStorage,
  factory: typeof createClient = createClient,
): () => SupabaseClient | null {
  let initialized = false
  let client: SupabaseClient | null = null
  return () => {
    if (initialized) return client
    initialized = true
    const { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key } = configuration
    if (typeof url !== 'string' || typeof key !== 'string') return null
    // Accept public publishable keys only, never legacy JWTs or secret keys.
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null
    try {
      const parsed = new URL(url)
      if (url !== url.trim() || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.search || parsed.hash || parsed.pathname !== '/') return null
      client = factory(parsed.origin, key, { auth: {
        storage: storage(),
        persistSession: true,
        autoRefreshToken: true,
        // Only the dedicated callback page processes URL tokens.
        flowType: 'implicit',
        detectSessionInUrl: false,
      } })
    } catch {
      // Configuration and SDK errors can contain credentials; never expose them.
      client = null
    }
    return client
  }
}

export const getBrowserAuthClient = createAuthClientGetter({
  VITE_SUPABASE_URL: import.meta.env?.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY,
})

function sessionState(session: Session | null): AuthState {
  return session ? { status: 'signed_in', session, user: session.user } : { status: 'signed_out' }
}

// Shared by the React effect and mocked lifecycle tests. No auth calls in callbacks.
export function observeAuth(auth: AuthClient | null, publish: (state: AuthState) => void): () => void {
  if (!auth) {
    publish({ status: 'unavailable' })
    return () => {}
  }
  let active = true
  let eventReceived = false
  let initialized = false
  let unsubscribe: (() => void) | undefined
  publish({ status: 'loading' })
  const stop = () => {
    active = false
    unsubscribe?.()
    unsubscribe = undefined
  }
  try {
    const { data } = auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'INITIAL_SESSION') {
        if (eventReceived || initialized) return
      } else {
        eventReceived = true
      }
      publish(sessionState(session))
    })
    unsubscribe = () => data.subscription.unsubscribe()
    void auth.getSession().then(({ data, error }) => {
      if (!active || eventReceived) return
      initialized = true
      publish(error ? { status: 'unavailable' } : sessionState(data.session))
    }).catch(() => {
      if (!active || eventReceived) return
      initialized = true
      publish({ status: 'unavailable' })
    })
  } catch {
    stop()
    publish({ status: 'unavailable' })
  }
  return stop
}

export type AuthOutcome = 'signed_in' | 'confirmation_pending' | 'signed_out' | 'failed' | 'unavailable' | 'login_failed' | 'network_failed'
export const authMessages: Record<AuthOutcome, string> = {
  signed_in: 'Signed in. The dashboard still shows fictional demo data, not your personal portfolio.',
  confirmation_pending: 'If signup can proceed, check your email for a confirmation link. If you already have an account, try logging in. This response does not confirm that an account was created.',
  signed_out: 'Signed out of this session.',
  failed: 'Unable to complete authentication. Please try again later.',
  login_failed: 'Unable to log in. Check your email and password and try again.',
  network_failed: 'Unable to reach the authentication service. Check your connection and try again later.',
  unavailable: 'Authentication is unavailable. Check the public application configuration. Demo access is still available.',
}

type FormAuth = Pick<SupabaseClient['auth'], 'signUp' | 'signInWithPassword' | 'signOut' | 'setSession'>

export function trustedCallback(value: unknown, origin: string): string | null {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.origin !== origin || url.pathname !== '/auth/callback' || url.search || url.hash
      || url.username || url.password || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) return null
    return url.href
  } catch { return null }
}

export function browserCallback(): string | null {
  return trustedCallback(import.meta.env?.VITE_AUTH_CALLBACK_URL, window.location.origin)
}

function credentialFailure(error: unknown, mode: 'login' | 'signup'): AuthOutcome {
  if (typeof error === 'object' && error !== null) {
    const details = error as { name?: unknown; status?: unknown; code?: unknown }
    if (details.code === 'invalid_api_key') return 'unavailable'
    if (details.name === 'AuthRetryableFetchError' || details.name === 'TypeError'
      || (typeof details.status === 'number' && details.status >= 500)) return 'network_failed'
  }
  return mode === 'login' ? 'login_failed' : 'failed'
}

export async function submitCredentials(auth: FormAuth | null, input: {
  mode: 'login' | 'signup'; email: string; password: string; fullName: string
}, callback: string | null): Promise<AuthOutcome> {
  if (!auth || (input.mode === 'signup' && !callback)) return 'unavailable'
  try {
    const { data, error } = input.mode === 'login'
      ? await auth.signInWithPassword({ email: input.email.trim(), password: input.password })
      : await auth.signUp({ email: input.email.trim(), password: input.password,
        options: { emailRedirectTo: callback!, data: { full_name: input.fullName.trim() } } })
    if (error) return credentialFailure(error, input.mode)
    if (data.session) return 'signed_in'
    return input.mode === 'signup' ? 'confirmation_pending' : 'login_failed'
  } catch (error) { return credentialFailure(error, input.mode) }
}

export async function signOutLocal(auth: FormAuth | null): Promise<AuthOutcome> {
  if (!auth) return 'unavailable'
  try { return (await auth.signOut({ scope: 'local' })).error ? 'failed' : 'signed_out' }
  catch { return 'failed' }
}

// Retains only one result promise, not callback tokens. Reused across Strict Mode effects.
export function createConfirmationHandler() {
  let pending: Promise<AuthOutcome> | undefined
  return (auth: FormAuth | null, location: { origin: string; pathname: string; search: string; hash: string },
    callback: string | null, clearUrl: () => void): Promise<AuthOutcome> => {
    if (pending) return pending
    const run = async (): Promise<AuthOutcome> => {
      // Remove credentials/errors from the address bar even for invalid callbacks.
      clearUrl()
      if (!auth || !callback) return 'unavailable'
      if (`${location.origin}${location.pathname}` !== callback || location.search || location.hash.length > 16384) return 'failed'
      const params = new URLSearchParams(location.hash.replace(/^#/, ''))
      if (params.has('error') || params.has('error_code') || params.get('type') !== 'signup'
        || params.get('token_type') !== 'bearer'
        || ['access_token', 'refresh_token', 'type', 'token_type'].some((key) => params.getAll(key).length !== 1)) return 'failed'
      const access_token = params.get('access_token'), refresh_token = params.get('refresh_token')
      if (!access_token || !refresh_token) return 'failed'
      const { data, error } = await auth.setSession({ access_token, refresh_token })
      return !error && data.session ? 'signed_in' : 'failed'
    }
    pending = run().catch(() => 'failed')
    return pending
  }
}

/** Component-owned gate: prevents concurrent submissions before React rerenders. */
export function createSubmissionGate() {
  let busy = false
  return async (work: () => Promise<AuthOutcome>): Promise<AuthOutcome | null> => {
    if (busy) return null
    busy = true
    try { return await work() } finally { busy = false }
  }
}
