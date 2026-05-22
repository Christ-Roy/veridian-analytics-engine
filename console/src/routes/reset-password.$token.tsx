import { useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { createFileRoute } from '@tanstack/react-router'
import { App, Form, Input, Button, Result } from 'antd'
import { api } from '../lib/api'
import { AuthShell } from '../veridian/auth-shell'

export const Route = createFileRoute('/reset-password/$token')({
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { message } = App.useApp()
  const { token } = useParams({ from: '/reset-password/$token' })
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const onFinish = async (values: {
    password: string
    confirmPassword: string
  }) => {
    if (values.password !== values.confirmPassword) {
      message.error('Les mots de passe ne correspondent pas')
      return
    }

    setLoading(true)

    try {
      await api.auth.resetPassword(token, values.password)
      setSuccess(true)
    } catch (err) {
      message.error(
        err instanceof Error
          ? err.message
          : 'Échec de la réinitialisation du mot de passe',
      )
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <AuthShell>
        <Result
          status="success"
          title="Mot de passe réinitialisé"
          subTitle="Votre mot de passe a été mis à jour. Vous pouvez désormais vous connecter."
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
      <Form onFinish={onFinish} layout="vertical">
        <Form.Item
          name="password"
          rules={[
            { required: true, message: 'Veuillez entrer un mot de passe' },
            { min: 8, message: 'Le mot de passe doit faire au moins 8 caractères' },
          ]}
        >
          <Input.Password
            placeholder="Nouveau mot de passe"
            size="large"
            autoComplete="new-password"
          />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          rules={[
            { required: true, message: 'Veuillez confirmer votre mot de passe' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) {
                  return Promise.resolve()
                }
                return Promise.reject(
                  new Error('Les mots de passe ne correspondent pas'),
                )
              },
            }),
          ]}
        >
          <Input.Password
            placeholder="Confirmer le mot de passe"
            size="large"
            autoComplete="new-password"
          />
        </Form.Item>

        <Form.Item className="mb-0">
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            block
            size="large"
          >
            Réinitialiser le mot de passe
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
    </AuthShell>
  )
}
