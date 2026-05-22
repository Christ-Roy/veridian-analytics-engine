import { createFileRoute, useNavigate, redirect, Link } from '@tanstack/react-router'
import { App, Form, Input, Button } from 'antd'
import { useAuth } from '../lib/useAuth'
import { useEffect, useRef } from 'react'
import { AuthShell } from '../veridian/auth-shell'

type LoginSearch = {
  email?: string
  password?: string
  redirect?: string
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    email: typeof search.email === 'string' ? search.email : undefined,
    password: typeof search.password === 'string' ? search.password : undefined,
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (context.auth.isAuthenticated) {
      throw redirect({ to: '/' })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  const { message } = App.useApp()
  const { login, isDemo } = useAuth()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const { email, password, redirect: redirectTo } = Route.useSearch()
  const autoLoginAttempted = useRef(false)

  const handleLogin = async (emailVal: string, passwordVal: string) => {
    try {
      await login(emailVal, passwordVal)
      navigate({ to: redirectTo || '/' })
    } catch {
      message.error('Identifiants invalides')
    }
  }

  const onFinish = (values: { email: string; password: string }) => {
    handleLogin(values.email, values.password)
  }

  // Auto-login if email and password are provided in URL params
  useEffect(() => {
    if (email && password && !autoLoginAttempted.current) {
      autoLoginAttempted.current = true
      form.setFieldsValue({ email, password })
      setTimeout(async () => {
        try {
          await login(email, password)
          navigate({ to: redirectTo || '/' })
        } catch {
          message.error('Identifiants invalides')
        }
      }, 100)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password])

  return (
    <AuthShell>
      {isDemo && (
        <p className="text-center text-sm text-gray-500 mb-6">
          Connectez-vous à votre dashboard Veridian Analytics
        </p>
      )}
      <Form form={form} onFinish={onFinish} layout="vertical">
        <Form.Item
          name="email"
          rules={[
            { required: true, type: 'email', message: 'Email valide requis' },
          ]}
        >
          <Input placeholder="Email" size="large" autoComplete="email" />
        </Form.Item>
        <Form.Item
          name="password"
          rules={[{ required: true, message: 'Mot de passe requis' }]}
        >
          <Input.Password
            placeholder="Mot de passe"
            size="large"
            autoComplete="current-password"
          />
        </Form.Item>
        <Form.Item className="mb-0">
          <Button type="primary" htmlType="submit" block size="large">
            Se connecter
          </Button>
        </Form.Item>

        <div className="text-center mt-4">
          <Link
            to="/forgot-password"
            className="text-sm text-purple-600 hover:text-purple-700"
          >
            Mot de passe oublié ?
          </Link>
        </div>
      </Form>
    </AuthShell>
  )
}
