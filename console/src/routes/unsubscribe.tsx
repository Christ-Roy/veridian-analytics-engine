import { useState, useEffect } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Button, Spin, Result } from 'antd'
import { z } from 'zod'
import { api } from '../lib/api'

const unsubscribeSearchSchema = z.object({
  token: z.string().optional(),
})

export const Route = createFileRoute('/unsubscribe')({
  component: UnsubscribePage,
  validateSearch: unsubscribeSearchSchema,
})

function UnsubscribePage() {
  const { token } = Route.useSearch()
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setLoading(false)
      setError('Lien de désinscription invalide')
      return
    }

    async function unsubscribe() {
      try {
        await api.subscriptions.unsubscribe(token!)
        setSuccess(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Échec de la désinscription')
      } finally {
        setLoading(false)
      }
    }

    unsubscribe()
  }, [token])

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-cover bg-center relative"
      style={{
        backgroundImage: 'url(/background.jpg)',
      }}
    >
      <div className="bg-white/95 backdrop-blur-sm p-8 rounded-lg shadow-xl w-full max-w-md">
        <img src="/veridian-logo.svg" alt="Veridian Analytics" className="h-8 mx-auto mb-8" />

        {loading ? (
          <div className="text-center py-8">
            <Spin size="large" />
            <p className="mt-4 text-gray-500">Traitement de votre demande…</p>
          </div>
        ) : success ? (
          <Result
            status="success"
            title="Désinscription réussie"
            subTitle="Vous ne recevrez plus ce rapport email."
            extra={[
              <Link to="/login" key="login">
                <Button type="primary">
                  Se connecter pour gérer les abonnements
                </Button>
              </Link>,
            ]}
          />
        ) : (
          <Result
            status="error"
            title="Échec de la désinscription"
            subTitle={error || 'Le lien de désinscription est peut-être invalide ou expiré.'}
            extra={[
              <Link to="/login" key="login">
                <Button type="primary">
                  Se connecter pour gérer les abonnements
                </Button>
              </Link>,
            ]}
          />
        )}
      </div>

      {/* Photo credit */}
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
