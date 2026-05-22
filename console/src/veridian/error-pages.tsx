import { Result, Button, ConfigProvider } from 'antd'

/**
 * Pages d'erreur brandées Veridian (ticket U9).
 *
 * Le router TanStack a besoin de deux composants globaux :
 *   - `notFoundComponent` : route inconnue (404)
 *   - `errorComponent`    : exception non rattrapée pendant le rendu
 *
 * Avant U9, le `__root.tsx` n'avait qu'un `errorComponent` Staminads brut
 * (fond gris, titre anglais générique) et AUCUN 404 — une URL inconnue
 * affichait le fallback technique nu de TanStack. U9 fournit deux écrans
 * soignés, en français, avec un retour clair vers le dashboard.
 *
 * Choix d'implémentation : on utilise un `<a href="/">` plutôt que le `<Link>`
 * TanStack. Une page d'erreur / 404 peut s'afficher alors que le routeur
 * lui-même est dans un état dégradé — une navigation dure (full reload) est
 * le retour le plus fiable. Ça rend aussi ces composants testables sans
 * monter un routeur (Vitest exclut TanStack Router, cf vitest.config.ts).
 *
 * On reste sur AntDesign `Result` (cohérent avec le reste de la console
 * staminads) ; le `ConfigProvider` applique le primary violet de la console.
 */

const PRIMARY = '#7763f1'

/** Écran 404 — route inconnue. Branché sur `notFoundComponent`. */
export function NotFoundPage() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: PRIMARY } }}>
      <div
        className="min-h-screen flex items-center justify-center bg-cover bg-center"
        style={{ backgroundImage: 'url(/background.jpg)' }}
        data-testid="not-found-page"
      >
        <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-xl px-6 py-4 max-w-md w-full">
          <Result
            status="404"
            title="Page introuvable"
            subTitle="Cette page n'existe pas ou a été déplacée. Vérifiez l'adresse ou revenez à votre dashboard."
            extra={
              <a href="/" data-testid="not-found-home-link">
                <Button type="primary" size="large">
                  Retour au dashboard
                </Button>
              </a>
            }
          />
        </div>
      </div>
    </ConfigProvider>
  )
}

/**
 * Écran d'erreur générique — exception non rattrapée. Branché sur
 * `errorComponent` du root route.
 */
export function AppErrorPage({ error }: { error?: Error }) {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: PRIMARY } }}>
      <div
        className="min-h-screen flex items-center justify-center bg-cover bg-center"
        style={{ backgroundImage: 'url(/background.jpg)' }}
        data-testid="app-error-page"
      >
        <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-xl px-6 py-4 max-w-md w-full">
          <Result
            status="error"
            title="Une erreur est survenue"
            subTitle={
              error?.message ||
              "Quelque chose s'est mal passé. Réessayez ou revenez à votre dashboard."
            }
            extra={
              <Button
                type="primary"
                size="large"
                data-testid="app-error-home-button"
                onClick={() => {
                  window.location.href = '/'
                }}
              >
                Retour au dashboard
              </Button>
            }
          />
        </div>
      </div>
    </ConfigProvider>
  )
}
