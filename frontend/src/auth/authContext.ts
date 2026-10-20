import { createContext, useContext } from 'react'
import type { AuthState } from '../lib/auth'

export const AuthContext = createContext<AuthState>({ status: 'unavailable' })

/** UI session state only; backend requests still require independent verification. */
export function useAuth(): AuthState {
  return useContext(AuthContext)
}
