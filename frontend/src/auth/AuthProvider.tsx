import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getBrowserAuthClient, observeAuth } from '../lib/auth'
import type { AuthState } from '../lib/auth'
import { AuthContext } from './authContext'

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  useEffect(() => observeAuth(getBrowserAuthClient()?.auth ?? null, setState), [])
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}
