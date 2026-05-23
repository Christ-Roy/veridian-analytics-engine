import { useState, useEffect } from 'react'
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { Button, Form, Input, Spin, Avatar, Tag } from 'antd'
import { TeamOutlined, GlobalOutlined } from '@ant-design/icons'
import { useAuth } from '../lib/useAuth'
import { api } from '../lib/api'
import type { InvitationDetails } from '../types/invitation'

export const Route = createFileRoute('/invite/$token')({
  component: InviteAcceptPage,
})

function InviteAcceptPage() {
  const params = Route.useParams() as { token: string }
  const token = params.token
  const navigate = useNavigate()
  const { isAuthenticated, login } = useAuth()

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null)
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)

  // Fetch invitation details
  useEffect(() => {
    const fetchInvitation = async () => {
      try {
        const data = await api.invitations.get(token)
        setInvitation(data)

        // Check if expired
        if (new Date(data.expiresAt) < new Date()) {
          setExpired(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invitation invalide')
      } finally {
        setLoading(false)
      }
    }

    fetchInvitation()
  }, [token])

  // Fetch current user if authenticated
  useEffect(() => {
    const fetchCurrentUser = async () => {
      if (isAuthenticated) {
        try {
          const user = await api.auth.me()
          setCurrentUserEmail(user.email)
        } catch {
          // Ignore error
        }
      }
    }

    fetchCurrentUser()
  }, [isAuthenticated])

  // Handle new user registration
  const handleNewUserSubmit = async (values: {
    name: string
    password: string
    confirmPassword: string
  }) => {
    if (values.password !== values.confirmPassword) {
      setError('Les mots de passe ne correspondent pas')
      return
    }

    setAccepting(true)
    setError(null)

    try {
      const result = await api.invitations.accept({
        token,
        name: values.name,
        password: values.password,
      })

      // Auto-login after registration
      if (invitation) {
        await login(invitation.email, values.password)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to: `/workspaces/${result.workspaceId}` } as any)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'acceptation de l'invitation")
    } finally {
      setAccepting(false)
    }
  }

  // Handle existing user confirmation
  const handleExistingUserAccept = async () => {
    setAccepting(true)
    setError(null)

    try {
      const result = await api.invitations.accept({ token })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to: `/workspaces/${result.workspaceId}` } as any)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'acceptation de l'invitation")
    } finally {
      setAccepting(false)
    }
  }

  const roleColors: Record<string, string> = {
    admin: 'purple',
    editor: 'blue',
    viewer: 'default',
  }

  const renderContent = () => {
    // Loading state
    if (loading) {
      return (
        <div className="text-center py-8">
          <Spin size="large" />
          <p className="mt-4 text-gray-600">Chargement de l'invitation…</p>
        </div>
      )
    }

    // Error state
    if (error && !invitation) {
      return (
        <div className="text-center">
          <p className="text-red-600 mb-6">{error}</p>
          <Link to="/login">
            <Button type="primary" block size="large">
              Aller à la connexion
            </Button>
          </Link>
        </div>
      )
    }

    // Expired state
    if (expired) {
      return (
        <div className="text-center">
          <p className="text-gray-600 mb-6">
            Ce lien d'invitation a expiré. Contactez l'administrateur de l'espace de travail pour en obtenir une nouvelle.
          </p>
          <Link to="/login">
            <Button type="primary" block size="large">
              Aller à la connexion
            </Button>
          </Link>
        </div>
      )
    }

    if (!invitation) return null

    return (
      <>
        {/* Workspace Info */}
        <div className="text-center mb-6">
          {invitation.workspace.logo_url ? (
            <Avatar
              src={invitation.workspace.logo_url}
              size={64}
              className="mb-4"
            />
          ) : (
            <Avatar
              size={64}
              icon={<TeamOutlined />}
              className="mb-4 bg-purple-500"
            />
          )}

          <h2 className="text-xl font-semibold mb-1">
            Rejoindre {invitation.workspace.name}
          </h2>

          <div className="flex items-center justify-center gap-2 text-gray-500 mb-2">
            <GlobalOutlined />
            <span>{invitation.workspace.website}</span>
          </div>

          <Tag color={roleColors[invitation.role]}>
            {invitation.role === 'admin' ? 'Admin' : invitation.role === 'editor' ? 'Éditeur' : invitation.role === 'viewer' ? 'Lecteur' : invitation.role}
          </Tag>
        </div>

        <div className="border-t border-gray-200 my-6" />

        <p className="text-center text-gray-600 mb-6">
          <strong>{invitation.inviter.name}</strong> vous invite à rejoindre cet
          espace de travail en tant que{' '}
          <strong>{invitation.role === 'admin' ? 'admin' : invitation.role === 'editor' ? 'éditeur' : 'lecteur'}</strong>.
        </p>

        {/* Existing User Flow */}
        {invitation.existingUser ? (
          <div>
            {isAuthenticated && currentUserEmail === invitation.email ? (
              // Logged in as correct user
              <div className="text-center">
                <p className="text-gray-600 mb-4">
                  Vous êtes connecté en tant que <strong>{currentUserEmail}</strong>
                </p>
                <Button
                  type="primary"
                  size="large"
                  block
                  loading={accepting}
                  onClick={handleExistingUserAccept}
                >
                  Accepter l'invitation
                </Button>
              </div>
            ) : isAuthenticated ? (
              // Logged in as different user
              <div className="text-center">
                <p className="text-amber-600 mb-4">
                  Cette invitation est pour {invitation.email}, mais vous êtes connecté en tant que {currentUserEmail}. Veuillez vous déconnecter et vous reconnecter avec le bon compte.
                </p>
                <Button
                  type="primary"
                  size="large"
                  block
                  onClick={() => navigate({ to: '/login' })}
                >
                  Se connecter en tant que {invitation.email}
                </Button>
              </div>
            ) : (
              // Not logged in
              <div className="text-center">
                <p className="text-gray-600 mb-4">
                  Vous avez déjà un compte. Veuillez vous connecter pour accepter cette invitation.
                </p>
                <Link to="/login" search={{ redirect: `/invite/${token}` }}>
                  <Button type="primary" size="large" block>
                    Se connecter pour accepter
                  </Button>
                </Link>
              </div>
            )}
          </div>
        ) : (
          /* New User Registration Flow */
          <div>
            <p className="text-center text-gray-600 mb-4">
              Créez votre compte pour rejoindre l'espace de travail
            </p>

            <Form
              name="accept-invitation"
              onFinish={handleNewUserSubmit}
              layout="vertical"
            >
              <Form.Item label="Email">
                <Input
                  value={invitation.email}
                  disabled
                  size="large"
                />
              </Form.Item>

              <Form.Item
                name="name"
                label="Votre nom"
                rules={[
                  { required: true, message: 'Veuillez saisir votre nom' },
                  { min: 1, max: 100, message: 'Le nom doit faire 1 à 100 caractères' },
                ]}
              >
                <Input
                  placeholder="Saisissez votre nom complet"
                  size="large"
                  autoComplete="name"
                />
              </Form.Item>

              <Form.Item
                name="password"
                label="Mot de passe"
                rules={[
                  { required: true, message: 'Veuillez saisir un mot de passe' },
                  { min: 8, message: 'Le mot de passe doit faire au moins 8 caractères' },
                ]}
              >
                <Input.Password
                  placeholder="Créez un mot de passe"
                  size="large"
                  autoComplete="new-password"
                />
              </Form.Item>

              <Form.Item
                name="confirmPassword"
                label="Confirmer le mot de passe"
                rules={[
                  { required: true, message: 'Veuillez confirmer votre mot de passe' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) {
                        return Promise.resolve()
                      }
                      return Promise.reject(new Error('Les mots de passe ne correspondent pas'))
                    },
                  }),
                ]}
              >
                <Input.Password
                  placeholder="Confirmez votre mot de passe"
                  size="large"
                  autoComplete="new-password"
                />
              </Form.Item>

              <Form.Item className="mb-0">
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  size="large"
                  loading={accepting}
                >
                  Créer le compte et rejoindre
                </Button>
              </Form.Item>
            </Form>
          </div>
        )}

        <div className="border-t border-gray-200 my-6" />

        <p className="text-center text-xs text-gray-500">
          En rejoignant, vous acceptez les conditions et politiques de l'espace de travail.
        </p>
      </>
    )
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-cover bg-center relative"
      style={{
        backgroundImage: 'url(/background.jpg)',
      }}
    >
      <div className="bg-white/95 backdrop-blur-sm p-8 rounded-lg shadow-xl w-full max-w-sm">
        <img src="/veridian-logo.svg" alt="Veridian Analytics" className="h-8 mx-auto mb-8" />
        {renderContent()}
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
