import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'
import { App, Form, Input, Button } from 'antd'
import { api } from '../lib/api'
import { AuthShell } from '../veridian/auth-shell'

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const onFinish = async (values: { email: string }) => {
    setLoading(true)

    try {
      await api.auth.forgotPassword(values.email)
      setSuccess(true)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Échec de la demande')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
      {success ? (
        <div className="text-center" data-testid="forgot-password-success">
          <p className="text-gray-600 mb-6">
            Si un compte existe avec cet email, nous venons d'envoyer les
            instructions de réinitialisation du mot de passe.
          </p>
          <Link to="/login">
            <Button type="primary" block size="large">
              Retour à la connexion
            </Button>
          </Link>
        </div>
      ) : (
        <Form onFinish={onFinish} layout="vertical">
          <p className="text-center text-gray-600 mb-6">
            Entrez votre email, nous vous enverrons un lien de
            réinitialisation
          </p>

          <Form.Item
            name="email"
            rules={[
              { required: true, message: 'Veuillez entrer votre email' },
              { type: 'email', message: 'Veuillez entrer un email valide' },
            ]}
          >
            <Input placeholder="Email" size="large" autoComplete="email" />
          </Form.Item>

          <Form.Item className="mb-0">
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
            >
              Envoyer le lien
            </Button>
          </Form.Item>

          <div className="text-center mt-4">
            <Link
              to="/login"
              className="text-sm text-purple-600 hover:text-purple-700"
            >
              Retour à la connexion
            </Link>
          </div>
        </Form>
      )}
    </AuthShell>
  )
}
