import { createContext } from 'react'
import type { PublicConfig } from './demo-config'

export interface AuthUser {
  id: string
  email: string
  name: string
  isSuperAdmin: boolean
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  /**
   * Public runtime config (demo flag, branding). `null` until the
   * `/api/public-config` probe resolves on boot.
   */
  publicConfig: PublicConfig | null
  /** Convenience accessor — true when this instance runs in demo mode. */
  isDemo: boolean
}

export const AuthContext = createContext<AuthState | null>(null)
