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
        // Confirmation/redirect flows belong to the later form milestone.
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
