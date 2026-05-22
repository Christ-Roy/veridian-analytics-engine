import type { ReactNode } from 'react'
import { useAuth } from '../lib/useAuth'

/**
 * AuthShell — chrome commun à toutes les pages d'auth de la console
 * (login, mot de passe oublié, reset, setup).
 *
 * Pourquoi ce composant (ticket U9) :
 *   - Avant U9, chaque page d'auth dupliquait son fond + logo + crédit photo,
 *     et seule `login.tsx` switchait le logo Veridian/Staminads via `isDemo`.
 *     `forgot-password.tsx` et `reset-password.$token.tsx` affichaient
 *     `logo.svg` (Staminads) en dur même sur une instance Veridian.
 *   - AuthShell centralise le branding : sur une instance Veridian (demo),
 *     toutes les pages d'auth affichent le logo + le nom Veridian ; sur
 *     l'instance staminads interne, le branding upstream reste intact.
 *
 * Le branding « Veridian » est piloté par le flag runtime `isDemo` de
 * `AuthContext` (issu de `GET /api/public-config`). C'est le seul signal
 * runtime qui distingue une instance Veridian publique d'un build staminads
 * interne — le bundle console étant unique pour les deux.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { isDemo } = useAuth()

  const logoSrc = isDemo ? '/veridian-logo.svg' : '/logo.svg'
  const logoAlt = isDemo ? 'Veridian Analytics' : 'Staminads'

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-cover bg-center relative"
      style={{ backgroundImage: 'url(/background.jpg)' }}
    >
      <div className="bg-white/95 backdrop-blur-sm p-8 rounded-lg shadow-xl w-full max-w-sm">
        <img
          src={logoSrc}
          alt={logoAlt}
          className="h-9 mx-auto mb-8"
          data-testid="auth-logo"
        />
        {children}
      </div>

      {/* Crédit photo Unsplash — obligatoire pour le fond utilisé. */}
      <div className="absolute bottom-2 left-2 text-[10px] text-white/60">
        Photo by{' '}
        <a
          href="https://unsplash.com/fr/@rodlong?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText"
          className="underline hover:text-white/80"
          target="_blank"
          rel="noopener noreferrer"
        >
          Rod Long
        </a>
      </div>
    </div>
  )
}
