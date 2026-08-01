import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Result, Spin } from 'antd'
import { AuthShell } from '../veridian/auth-shell'

export const Route = createFileRoute('/sso')({
  component: SsoPage,
})

/**
 * Page d'atterrissage de l'autologin SSO.
 *
 * Le Hub redirige ici après avoir obtenu un jeton auprès de l'engine. Le jeton
 * arrive dans le FRAGMENT de l'URL (`/sso#<token>`), jamais dans la query
 * string : un fragment n'est pas transmis au serveur, il n'apparaît donc ni
 * dans les logs d'accès, ni dans l'en-tête `Referer` des requêtes que cette
 * page émet ensuite.
 *
 * Cette page existe parce que l'authentification de la console vit en
 * **localStorage**, pas en cookie. Une route serveur qui poserait un cookie de
 * session ne connecterait personne : il faut du code qui tourne dans la page
 * pour recevoir le JWT et le déposer là où le reste de l'application le lit.
 */
function SsoPage() {
  const [error, setError] = useState<string | null>(null)
  // React monte deux fois les composants en mode strict (développement). Sans
  // ce verrou, le jeton serait échangé deux fois : le second appel tomberait
  // sur un jeton déjà consommé et afficherait une erreur à un utilisateur
  // pourtant correctement connecté.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const exchange = async () => {
      const token = window.location.hash.replace(/^#/, '')

      // Retire le jeton de la barre d'adresse immédiatement, avant même de
      // l'échanger. Cela évite qu'il se retrouve dans l'historique de
      // navigation ou dans un signet posé au mauvais moment.
      window.history.replaceState(null, '', window.location.pathname)

      if (!token) {
        setError("Lien de connexion incomplet.")
        return
      }

      try {
        const res = await fetch('/api/sso.exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })

        if (!res.ok) {
          setError('Ce lien de connexion a expiré ou a déjà été utilisé.')
          return
        }

        const { access_token, user, workspace_id } = await res.json()

        localStorage.setItem('token', access_token)
        localStorage.setItem(
          'user',
          JSON.stringify({
            id: user.id,
            email: user.email,
            name: user.name,
            isSuperAdmin: user.is_super_admin,
          }),
        )

        // Navigation « dure » volontaire plutôt qu'un routage interne : elle
        // relance le AuthProvider, qui relit le jeton depuis localStorage à
        // l'initialisation. Un routage interne laisserait le contexte d'auth
        // sur son état précédent (déconnecté) jusqu'au prochain rechargement.
        window.location.replace(
          workspace_id ? `/workspaces/${workspace_id}` : '/',
        )
      } catch {
        setError('Connexion au service impossible. Réessayez.')
      }
    }

    void exchange()
  }, [])

  if (error) {
    return (
      <AuthShell>
        <Result
          status="warning"
          title="Connexion automatique impossible"
          subTitle={`${error} Vous pouvez vous connecter directement, ou relancer l'ouverture depuis votre espace Veridian.`}
          extra={
            <Link to="/login">
              <Button type="primary">Se connecter</Button>
            </Link>
          }
        />
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <Spin size="large" />
        <p style={{ marginTop: 24 }}>Connexion à votre espace…</p>
      </div>
    </AuthShell>
  )
}
