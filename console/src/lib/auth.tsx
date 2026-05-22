import { useState, useEffect, type ReactNode } from 'react'
import { AuthContext, type AuthUser } from './AuthContext'
import {
  fetchPublicConfig,
  demoLogin,
  applyDemoBranding,
  type PublicConfig,
} from './demo-config'

// Re-export types for convenience
export type { AuthState, AuthUser } from './AuthContext'

// Helper to get token from localStorage (runs once during initial render)
function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('token')
}

// Helper to get user from localStorage (runs once during initial render)
function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem('user')
  if (!stored) return null
  try {
    return JSON.parse(stored) as AuthUser
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Use lazy initialization to avoid useEffect
  const [token, setToken] = useState<string | null>(getStoredToken)
  const [user, setUser] = useState<AuthUser | null>(getStoredUser)
  const [isLoading, setIsLoading] = useState(true)
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null)

  // Boot sequence: fetch public config, then (demo mode) auto-login or
  // (normal mode) check whether initial setup is required.
  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      // 1. Resolve runtime config (demo flag + branding).
      const cfg = await fetchPublicConfig()
      if (cancelled) return
      setPublicConfig(cfg)

      // 2. Demo mode: brand the document + auto-login the anonymous visitor.
      if (cfg.is_demo) {
        applyDemoBranding()

        // Skip auto-login if a token is already present (visitor returning).
        if (!getStoredToken()) {
          const result = await demoLogin()
          if (cancelled) return
          if (result) {
            const authUser: AuthUser = {
              id: result.user.id,
              email: result.user.email,
              name: result.user.name,
              isSuperAdmin: result.user.is_super_admin,
            }
            localStorage.setItem('token', result.access_token)
            localStorage.setItem('user', JSON.stringify(authUser))
            setToken(result.access_token)
            setUser(authUser)
          }
          // If demoLogin() returned null the data is not seeded yet; the
          // router will render the login page, harmless on a public demo.
        }
        setIsLoading(false)
        return
      }

      // 3. Normal mode: redirect to the setup wizard if not yet initialized.
      if (window.location.pathname === '/setup') {
        setIsLoading(false)
        return
      }
      try {
        const res = await fetch('/api/setup.status')
        if (res.ok) {
          const { setupCompleted } = await res.json()
          if (!setupCompleted) {
            window.location.href = '/setup'
            return
          }
        }
      } catch {
        // If we can't check status, continue normally
      }
      if (!cancelled) setIsLoading(false)
    }

    boot()
    return () => {
      cancelled = true
    }
  }, [])

  const login = async (email: string, password: string) => {
    const res = await fetch('/api/auth.login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error('Invalid credentials')
    const { access_token, user: userData } = await res.json()
    const authUser: AuthUser = {
      id: userData.id,
      email: userData.email,
      name: userData.name,
      isSuperAdmin: userData.is_super_admin,
    }
    localStorage.setItem('token', access_token)
    localStorage.setItem('user', JSON.stringify(authUser))
    setToken(access_token)
    setUser(authUser)
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{
      token,
      user,
      isAuthenticated: !!token,
      isLoading,
      login,
      logout,
      publicConfig,
      isDemo: publicConfig?.is_demo ?? false,
    }}>
      {children}
    </AuthContext.Provider>
  )
}
