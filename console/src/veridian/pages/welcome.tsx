import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Steps,
  Typography,
  Space,
  Alert,
  Tag,
  message as antdMessage,
} from 'antd'
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CopyOutlined,
  RocketOutlined,
  CodeOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { fetchCheckTracker, BridgeApiError } from '../api'
import { buildTrackerSnippet } from '../snippet'

// Réexporté pour la compat des imports existants (`from '../welcome'`).
// La génération du snippet vit dans `../snippet` (source unique partagée avec
// install-sdk.tsx + l'onglet SDK de settings.tsx).
export { buildTrackerSnippet }

const { Title, Paragraph, Text } = Typography

/**
 * VeridianWelcomePage — onboarding `/welcome` (refonte UX 2026-06-24).
 *
 * 🔴 Principe figé par Robert : l'onboarding est NON BLOQUANT. Le client n'est
 * JAMAIS séquestré hors de son dashboard en attendant qu'un event arrive.
 * Cette page est une SUGGESTION soignée (copie le snippet, pose-le, vérifie si
 * tu veux) — mais le bouton « Accéder à mon tableau de bord » est toujours là,
 * en évidence, et y mène immédiatement.
 *
 * Différences avec l'ancienne version (le mur) :
 *   - plus aucun poll auto qui redirige seulement quand un event est détecté ;
 *   - la « Vérification » est manuelle, à la demande, purement informative ;
 *   - rendu 100 % AntDesign (thème console clair + accent violet), fini le
 *     `.veridian-scope` dark qui jurait avec tout le reste du produit.
 *
 * Props :
 *   - `workspaceId`     : id staminads du workspace (param de route)
 *   - `trackerEndpoint` : URL publique du tracker à coller dans le snippet
 *   - `tenantName`      : nom du workspace (affiché dans le titre)
 *   - `onComplete`      : callback « entrer dans le dashboard ». La route s'en
 *     sert pour flag le workspace actif puis naviguer vers le dashboard.
 */
export interface VeridianWelcomePageProps {
  workspaceId: string
  trackerEndpoint: string
  tenantName?: string
  onComplete?: () => void
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; firstSeenAt: string | null }
  | { kind: 'waiting' }
  | { kind: 'error'; message: string }

export function VeridianWelcomePage({
  workspaceId,
  trackerEndpoint,
  tenantName,
  onComplete,
}: VeridianWelcomePageProps) {
  const [current, setCurrent] = useState(0)
  const [copied, setCopied] = useState(false)
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  const snippet = useMemo(
    () => buildTrackerSnippet({ workspaceId, endpoint: trackerEndpoint }),
    [workspaceId, trackerEndpoint],
  )

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      antdMessage.success('Snippet copié dans le presse-papier')
      setTimeout(() => setCopied(false), 2200)
    } catch {
      // Clipboard refusé (permission, contexte non sécurisé) — on ne casse pas
      // l'UX, l'utilisateur peut sélectionner le code à la main.
      setCopied(false)
    }
  }, [snippet])

  // Vérification À LA DEMANDE — un seul appel, jamais de poll qui séquestre.
  const handleVerify = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setVerify({ kind: 'checking' })
    try {
      const res = await fetchCheckTracker(workspaceId, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      if (res.status === 'ok') {
        setVerify({ kind: 'ok', firstSeenAt: res.firstSeenAt })
      } else {
        setVerify({ kind: 'waiting' })
      }
    } catch (err) {
      if (ctrl.signal.aborted) return
      const accessDenied =
        err instanceof BridgeApiError &&
        (err.status === 401 || err.status === 403)
      setVerify({
        kind: 'error',
        message: accessDenied
          ? "Votre session n'a pas les droits pour vérifier ce workspace. Reconnectez-vous ou contactez le support."
          : 'Le service de vérification est momentanément indisponible. Réessayez dans quelques instants.',
      })
    }
  }, [workspaceId])

  return (
    <div className="p-6" data-testid="veridian-welcome-root">
      <div className="max-w-2xl mx-auto">
        {/* En-tête */}
        <header className="text-center mb-6">
          <Tag color="purple" className="!mb-3">
            <RocketOutlined /> Veridian Analytics
          </Tag>
          <Title level={2} className="!mb-1">
            Bienvenue{tenantName ? `, ${tenantName}` : ''}
          </Title>
          <Paragraph type="secondary" className="!mb-0">
            Installez le suivi de votre site en quelques minutes. Vous pouvez
            aussi accéder à votre tableau de bord dès maintenant et installer le
            snippet plus tard.
          </Paragraph>
        </header>

        {/* CTA non-bloquant — toujours disponible, en évidence */}
        <div className="flex justify-center mb-8">
          <Button
            type="primary"
            size="large"
            icon={<ArrowRightOutlined />}
            onClick={() => onComplete?.()}
            data-testid="welcome-enter-dashboard"
          >
            Accéder à mon tableau de bord
          </Button>
        </div>

        <Steps
          current={current}
          onChange={setCurrent}
          orientation="horizontal"
          responsive={false}
          size="small"
          className="!mb-6"
          data-testid="welcome-step-indicator"
          items={[
            { title: 'Snippet', icon: <CodeOutlined /> },
            { title: 'Installation', icon: <RocketOutlined /> },
            { title: 'Vérification', icon: <SafetyCertificateOutlined /> },
          ]}
        />

        <Card variant="borderless" className="shadow-sm">
          {current === 0 && (
            <StepSnippet
              snippet={snippet}
              copied={copied}
              onCopy={handleCopy}
              onNext={() => setCurrent(1)}
            />
          )}
          {current === 1 && (
            <StepInstall
              onBack={() => setCurrent(0)}
              onNext={() => setCurrent(2)}
            />
          )}
          {current === 2 && (
            <StepVerify
              state={verify}
              onBack={() => setCurrent(1)}
              onVerify={handleVerify}
              onEnter={() => onComplete?.()}
            />
          )}
        </Card>
      </div>
    </div>
  )
}

// ─── Étape 1 — Copie ton snippet ────────────────────────────────────────────

function StepSnippet({
  snippet,
  copied,
  onCopy,
  onNext,
}: {
  snippet: string
  copied: boolean
  onCopy: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-4" data-testid="welcome-step-snippet">
      <StepTitle
        icon={<CodeOutlined />}
        title="Copiez votre snippet"
        subtitle="Ce petit bout de code, invisible pour vos visiteurs, enregistre les visites de votre site en temps réel."
      />

      <div className="relative">
        <pre
          className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-4 text-[12px] leading-relaxed text-gray-700 m-0"
          data-testid="welcome-snippet-code"
        >
          <code>{snippet}</code>
        </pre>
        <Button
          size="small"
          icon={copied ? <CheckCircleFilled /> : <CopyOutlined />}
          onClick={onCopy}
          data-testid="welcome-copy-button"
          className="!absolute !right-3 !top-3"
        >
          {copied ? 'Copié' : 'Copier'}
        </Button>
      </div>

      <div className="flex justify-end">
        <Button
          type="primary"
          icon={<ArrowRightOutlined />}
          iconPlacement="end"
          onClick={onNext}
          data-testid="welcome-next-1"
        >
          Étape suivante
        </Button>
      </div>
    </div>
  )
}

// ─── Étape 2 — Pose-le dans ton site ────────────────────────────────────────

function StepInstall({
  onBack,
  onNext,
}: {
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-4" data-testid="welcome-step-install">
      <StepTitle
        icon={<RocketOutlined />}
        title="Posez-le dans votre site"
        subtitle="Collez le snippet juste avant la balise </head> de votre site. Il sera chargé sur toutes vos pages."
      />

      {/* Illustration : balise <head> avec le snippet inséré */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-[12px] leading-relaxed text-gray-400">
        <div>&lt;head&gt;</div>
        <div className="pl-4">&lt;title&gt;Mon site&lt;/title&gt;</div>
        <div className="pl-4">…</div>
        <div className="my-1.5 rounded-md border border-purple-200 bg-purple-50 px-2 py-1.5 text-[var(--primary)]">
          <Tag color="purple" className="!mr-1.5 !text-[10px]">
            ici
          </Tag>
          &lt;!-- snippet Veridian Analytics --&gt;
        </div>
        <div>&lt;/head&gt;</div>
      </div>

      <ul className="space-y-2 text-sm text-gray-600 list-none pl-0 m-0">
        <InstallTip>
          Le snippet doit être présent sur <strong>toutes les pages</strong> à
          suivre — placez-le dans le template / layout global de votre site.
        </InstallTip>
        <InstallTip>
          Sur la plupart des CMS (WordPress, Webflow, Shopify…), un champ « code
          dans le <code className="bg-gray-100 px-1 rounded">&lt;head&gt;</code> »
          existe dans les réglages du thème.
        </InstallTip>
        <InstallTip>
          Aucune autre configuration : une fois en place, les visites remontent
          automatiquement.
        </InstallTip>
      </ul>

      <Typography.Link
        href="https://docs.veridian.site/analytics/install"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="welcome-docs-link"
        className="text-xs"
      >
        Guide d'installation détaillé ↗
      </Typography.Link>

      <div className="flex items-center justify-between">
        <Button onClick={onBack} data-testid="welcome-back-2">
          Retour
        </Button>
        <Button
          type="primary"
          icon={<ArrowRightOutlined />}
          iconPlacement="end"
          onClick={onNext}
          data-testid="welcome-next-2"
        >
          C'est posé, vérifier
        </Button>
      </div>
    </div>
  )
}

function InstallTip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircleFilled className="mt-0.5 text-[var(--primary)] shrink-0" />
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}

// ─── Étape 3 — Vérifier (NON BLOQUANT, à la demande) ────────────────────────

function StepVerify({
  state,
  onBack,
  onVerify,
  onEnter,
}: {
  state: VerifyState
  onBack: () => void
  onVerify: () => void
  onEnter: () => void
}) {
  return (
    <div className="space-y-4" data-testid="welcome-step-verify">
      <StepTitle
        icon={<SafetyCertificateOutlined />}
        title="Vérifiez l'installation (facultatif)"
        subtitle="Vous pouvez vérifier que le tracker reçoit bien des visites. Ce n'est pas obligatoire : vous pouvez entrer dans votre tableau de bord à tout moment."
      />

      {state.kind === 'ok' && (
        <Alert
          type="success"
          showIcon
          data-testid="welcome-verify-ok"
          title="Tracker détecté"
          description={
            <>
              Votre tracker fonctionne.
              {state.firstSeenAt && (
                <> Première visite détectée le {formatFirstSeen(state.firstSeenAt)}.</>
              )}
            </>
          }
        />
      )}

      {state.kind === 'waiting' && (
        <Alert
          type="info"
          showIcon
          data-testid="welcome-verify-waiting"
          title="Aucune visite reçue pour l'instant"
          description="Ouvrez votre site dans un nouvel onglet pour générer une visite, puis relancez la vérification. Vous pouvez aussi entrer directement dans votre tableau de bord."
        />
      )}

      {state.kind === 'error' && (
        <Alert
          type="warning"
          showIcon
          data-testid="welcome-verify-error"
          title="Vérification impossible"
          description={state.message}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={onBack} data-testid="welcome-back-3">
          Revoir l'installation
        </Button>
        <Space>
          <Button
            loading={state.kind === 'checking'}
            onClick={onVerify}
            data-testid="welcome-verify-button"
          >
            Vérifier l'installation
          </Button>
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            iconPlacement="end"
            onClick={onEnter}
            data-testid="welcome-enter-dashboard-2"
          >
            Accéder au tableau de bord
          </Button>
        </Space>
      </div>
    </div>
  )
}

// ─── Primitives partagées ───────────────────────────────────────────────────

function StepTitle({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-[var(--primary)]">
        {icon}
      </div>
      <div>
        <Title level={4} className="!mb-1">
          {title}
        </Title>
        <Text type="secondary" className="text-sm leading-relaxed">
          {subtitle}
        </Text>
      </div>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatFirstSeen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
