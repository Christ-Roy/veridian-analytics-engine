import { useState } from 'react'
import { Alert, Button, Space } from 'antd'
import { RocketOutlined } from '@ant-design/icons'
import { Link } from '@tanstack/react-router'

/**
 * Encart d'onboarding NON BLOQUANT (refonte UX 2026-06-24).
 *
 * Affiché en tête du dashboard tant que le workspace n'a pas encore reçu
 * d'event tracker (`status !== 'active'`). C'est une SUGGESTION : le client a
 * déjà accès à tout son dashboard, on lui rappelle juste comment installer le
 * tracker. Dismissable, et le « dismiss » est mémorisé par workspace (l'encart
 * ne réapparaît pas à chaque navigation) — il revient seulement si le client
 * vide son stockage local, et de toute façon disparaît dès le premier event.
 */
export function OnboardingBanner({ workspaceId }: { workspaceId: string }) {
  const storageKey = `veridian.onboarding.dismissed.${workspaceId}`
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  const handleClose = () => {
    setDismissed(true)
    try {
      localStorage.setItem(storageKey, '1')
    } catch {
      /* stockage indisponible — on masque pour la session, sans persister */
    }
  }

  return (
    <Alert
      type="info"
      showIcon
      closable
      onClose={handleClose}
      icon={<RocketOutlined />}
      className="!mb-4"
      data-testid="onboarding-banner"
      title="Le suivi de votre site n'est pas encore actif"
      description={
        <Space direction="vertical" size={8} className="w-full">
          <span>
            Aucune visite n'a encore été reçue. Installez le snippet Veridian
            Analytics sur votre site pour commencer à collecter vos données.
          </span>
          <Link to="/workspaces/$workspaceId/welcome" params={{ workspaceId }}>
            <Button type="primary" size="small" icon={<RocketOutlined />}>
              Installer le tracker
            </Button>
          </Link>
        </Space>
      }
    />
  )
}
