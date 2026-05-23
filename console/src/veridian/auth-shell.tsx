import type { ReactNode } from 'react'

/**
 * AuthShell — chrome commun à toutes les pages d'auth de la console
 * (login, mot de passe oublié, reset, setup).
 *
 * Branding figé Veridian sur tous les déploiements (BUG-08/09 — fix
 * upstream-branding-cleanup 2026-05-23). Le fork Veridian ne sert plus
 * jamais de marque Staminads, peu importe `isDemo`. Le flag isDemo reste
 * utilisé pour le banner FR + footer démo + auto-login anonyme, mais ne
 * pilote plus le branding visuel.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const logoSrc = '/veridian-logo.svg'
  const logoAlt = 'Veridian Analytics'

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
