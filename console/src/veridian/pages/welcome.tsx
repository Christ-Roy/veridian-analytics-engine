import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  Copy,
  ExternalLink,
  LifeBuoy,
  Loader2,
  RefreshCw,
  Rocket,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { cn } from '../utils';
import { fetchCheckTracker, BridgeApiError } from '../api';
import '../theme.css';

/**
 * VeridianWelcomePage — onboarding wizard `/welcome` (ticket U4 / ex-C3).
 *
 * Guide un nouveau tenant pour installer le tracker Veridian sur son site,
 * en 3 étapes avec vérification automatique :
 *   1. "Copie ton snippet"   — bloc <script> généré + bouton copier + toast
 *   2. "Pose-le dans ton site" — guide générique (coller avant </head>)
 *   3. "Vérifier"            — poll GET /api/admin/tenant/:id/check-tracker
 *      toutes les 5s ; états waiting / ok (redirect) / timeout 60s.
 *
 * C'est la PREMIÈRE impression d'un nouveau client : tout est soigné, scopé
 * sous `.veridian-scope` pour ne pas polluer le thème AntDesign de la console.
 *
 * Props :
 *   - `workspaceId`  : id staminads du workspace (param de route)
 *   - `trackerEndpoint` : URL publique du tracker à coller dans le snippet
 *     (prod : analytics-engine.app.veridian.site ; dev : staging). Résolue
 *     par la route via VITE_VERIDIAN_TRACKER_URL ou window.location.origin.
 *   - `onComplete` : callback déclenché quand le tracker est détecté (la
 *     route l'utilise pour rediriger vers le dashboard).
 *   - `pollIntervalMs` / `timeoutMs` : overridables pour les tests.
 */

export interface VeridianWelcomePageProps {
  workspaceId: string;
  trackerEndpoint: string;
  tenantName?: string;
  onComplete?: () => void;
  /** Intervalle de polling (défaut 5000ms). Réduit dans les tests. */
  pollIntervalMs?: number;
  /** Timeout avant message d'aide (défaut 60000ms). Réduit dans les tests. */
  timeoutMs?: number;
  /** Délai avant redirection après détection (défaut 3000ms). */
  redirectDelayMs?: number;
}

type WizardStep = 0 | 1 | 2;

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'polling'; elapsedMs: number }
  | { kind: 'ok'; firstSeenAt: string | null }
  | { kind: 'timeout' }
  | { kind: 'error'; error: Error };

const STEPS: Array<{ label: string; short: string }> = [
  { label: 'Copie ton snippet', short: 'Snippet' },
  { label: 'Pose-le dans ton site', short: 'Installation' },
  { label: 'Vérifier', short: 'Vérification' },
];

const DEFAULT_POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_REDIRECT_MS = 3000;

/**
 * Construit le snippet `<script>` Veridian Analytics à coller dans le `<head>`.
 * Pointe vers l'endpoint public du tracker (analytics-engine) avec le
 * workspaceId pré-rempli. Le tracking visiteur est actif par défaut côté SDK.
 */
export function buildTrackerSnippet(opts: {
  workspaceId: string;
  endpoint: string;
}): string {
  // On retire un éventuel slash final pour un endpoint propre.
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  return `<!-- Veridian Analytics -->
<script>
  window.StaminadsConfig = {
    workspace_id: ${JSON.stringify(opts.workspaceId)},
    endpoint: ${JSON.stringify(endpoint)},
    trackSPA: true,
    trackScroll: true
  };
</script>
<script async src="${endpoint}/sdk/staminads.min.js"></script>
<!-- /Veridian Analytics -->`;
}

export function VeridianWelcomePage({
  workspaceId,
  trackerEndpoint,
  tenantName,
  onComplete,
  pollIntervalMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  redirectDelayMs = DEFAULT_REDIRECT_MS,
}: VeridianWelcomePageProps) {
  const [step, setStep] = useState<WizardStep>(0);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);

  const snippet = useMemo(
    () => buildTrackerSnippet({ workspaceId, endpoint: trackerEndpoint }),
    [workspaceId, trackerEndpoint],
  );

  // ─── Polling timers ────────────────────────────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const redirectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number>(0);

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    if (redirectRef.current) clearTimeout(redirectRef.current);
    pollRef.current = null;
    tickRef.current = null;
    redirectRef.current = null;
    abortRef.current?.abort();
  }, []);

  // Cleanup global à l'unmount.
  useEffect(() => clearTimers, [clearTimers]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
    abortRef.current?.abort();
  }, []);

  const pollOnce = useCallback(async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetchCheckTracker(workspaceId, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (res.status === 'ok') {
        stopPolling();
        setVerify({ kind: 'ok', firstSeenAt: res.firstSeenAt });
        redirectRef.current = setTimeout(() => {
          onComplete?.();
        }, redirectDelayMs);
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // Une erreur réseau ponctuelle ne doit pas tuer le polling : on log
      // l'état mais on laisse les ticks suivants retenter. Sauf 401/403 :
      // c'est un problème d'accès qui ne se résoudra pas tout seul.
      if (err instanceof BridgeApiError && (err.status === 401 || err.status === 403)) {
        stopPolling();
        setVerify({ kind: 'error', error: err });
      }
      // autres erreurs : on ignore, le prochain tick retentera.
    }
  }, [workspaceId, stopPolling, onComplete, redirectDelayMs]);

  const startVerification = useCallback(() => {
    clearTimers();
    startedAtRef.current = Date.now();
    setVerify({ kind: 'polling', elapsedMs: 0 });

    // Tick d'horloge pour le compteur d'attente + détection timeout.
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed >= timeoutMs) {
        stopPolling();
        setVerify((prev) =>
          prev.kind === 'polling' ? { kind: 'timeout' } : prev,
        );
        return;
      }
      setVerify((prev) =>
        prev.kind === 'polling' ? { kind: 'polling', elapsedMs: elapsed } : prev,
      );
    }, 1000);

    // Polling de l'endpoint.
    pollRef.current = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    void pollOnce(); // check immédiat sans attendre le premier intervalle
  }, [clearTimers, stopPolling, pollOnce, pollIntervalMs, timeoutMs]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard refusé (permission, contexte non sécurisé) — on ne casse
      // pas l'UX, l'utilisateur peut sélectionner le code à la main.
      setCopied(false);
    }
  }, [snippet]);

  const goToStep = useCallback(
    (next: WizardStep) => {
      if (next === 2) {
        startVerification();
      } else {
        clearTimers();
        setVerify({ kind: 'idle' });
      }
      setStep(next);
    },
    [startVerification, clearTimers],
  );

  return (
    <div
      className="veridian-scope min-h-screen px-4 py-10 sm:px-6 lg:px-10"
      data-testid="veridian-welcome-root"
    >
      <div className="mx-auto max-w-2xl space-y-8">
        <WelcomeHeader tenantName={tenantName} />

        <StepIndicator step={step} />

        <Card className="veridian-fade-in-delay-1 relative overflow-hidden border-border/60 bg-card/80">
          <div
            className="pointer-events-none absolute inset-0 opacity-50"
            style={{
              background:
                'radial-gradient(ellipse at top right, hsl(174 72% 56% / 0.10), transparent 60%)',
            }}
            aria-hidden
          />
          <CardContent className="relative p-6 sm:p-8">
            {step === 0 && (
              <StepSnippet
                snippet={snippet}
                copied={copied}
                onCopy={handleCopy}
                onNext={() => goToStep(1)}
              />
            )}
            {step === 1 && (
              <StepInstall
                onBack={() => goToStep(0)}
                onNext={() => goToStep(2)}
              />
            )}
            {step === 2 && (
              <StepVerify
                state={verify}
                timeoutMs={timeoutMs}
                onBack={() => goToStep(1)}
                onRetry={startVerification}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function WelcomeHeader({ tenantName }: { tenantName?: string }) {
  return (
    <header className="veridian-fade-in space-y-2 text-center">
      <div className="flex items-center justify-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" />
        Veridian Analytics
      </div>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Bienvenue{tenantName ? `, ${tenantName}` : ''}
      </h1>
      <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
        Trois étapes rapides pour activer le suivi de votre site. Aucune
        compétence technique requise — copier, coller, c’est parti.
      </p>
    </header>
  );
}

// ─── Step indicator (barre de progression 3 étapes) ─────────────────────────

function StepIndicator({ step }: { step: WizardStep }) {
  return (
    <ol
      className="veridian-fade-in-delay-1 flex items-center gap-2"
      data-testid="welcome-step-indicator"
      aria-label="Progression de l’installation"
    >
      {STEPS.map((s, idx) => {
        const isDone = idx < step;
        const isCurrent = idx === step;
        return (
          <li key={s.label} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                isDone &&
                  'border-primary bg-primary text-primary-foreground',
                isCurrent &&
                  'border-primary bg-primary/15 text-primary',
                !isDone &&
                  !isCurrent &&
                  'border-border/70 bg-card text-muted-foreground/70',
              )}
              data-testid={`step-dot-${idx}`}
              data-state={isDone ? 'done' : isCurrent ? 'current' : 'todo'}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isDone ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
            </div>
            <span
              className={cn(
                'hidden text-xs font-medium sm:inline',
                isCurrent ? 'text-foreground' : 'text-muted-foreground/70',
              )}
            >
              {s.short}
            </span>
            {idx < STEPS.length - 1 && (
              <div
                className={cn(
                  'h-px flex-1 rounded-full transition-colors',
                  isDone ? 'bg-primary/60' : 'bg-border/60',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Étape 1 — Copie ton snippet ────────────────────────────────────────────

function StepSnippet({
  snippet,
  copied,
  onCopy,
  onNext,
}: {
  snippet: string;
  copied: boolean;
  onCopy: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5" data-testid="welcome-step-snippet">
      <StepTitle
        icon={Code2}
        title="Copie ton snippet"
        subtitle="Ce petit bout de code, invisible pour vos visiteurs, enregistre les visites de votre site en temps réel."
      />

      <div className="relative">
        <pre
          className="overflow-x-auto rounded-lg border border-border/70 bg-background/80 p-4 text-[12px] leading-relaxed text-foreground/90 [scrollbar-width:thin]"
          data-testid="welcome-snippet-code"
        >
          <code>{snippet}</code>
        </pre>
        <button
          type="button"
          onClick={onCopy}
          data-testid="welcome-copy-button"
          aria-label="Copier le snippet"
          className={cn(
            'absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all',
            copied
              ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-300'
              : 'border-border/80 bg-card text-foreground hover:border-primary/60 hover:text-primary',
          )}
        >
          {copied ? (
            <>
              <ClipboardCheck className="h-3.5 w-3.5" />
              Copié
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copier
            </>
          )}
        </button>
      </div>

      {copied && (
        <p
          className="veridian-fade-in flex items-center gap-1.5 text-xs text-emerald-300"
          data-testid="welcome-copy-toast"
          role="status"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Snippet copié dans le presse-papier.
        </p>
      )}

      <div className="flex justify-end">
        <PrimaryButton onClick={onNext} testId="welcome-next-1">
          Étape suivante
          <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
      </div>
    </div>
  );
}

// ─── Étape 2 — Pose-le dans ton site ────────────────────────────────────────

function StepInstall({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5" data-testid="welcome-step-install">
      <StepTitle
        icon={Rocket}
        title="Pose-le dans ton site"
        subtitle="Collez le snippet juste avant la balise </head> de votre site. Il sera chargé sur toutes vos pages."
      />

      {/* Illustration : balise <head> avec le snippet inséré */}
      <div
        className="rounded-lg border border-border/60 bg-background/60 p-4 font-mono text-[12px] leading-relaxed"
        aria-hidden
      >
        <div className="text-muted-foreground/60">&lt;head&gt;</div>
        <div className="pl-4 text-muted-foreground/50">
          &lt;title&gt;Mon site&lt;/title&gt;
        </div>
        <div className="pl-4 text-muted-foreground/50">…</div>
        <div className="my-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-primary">
          <span className="mr-1.5 inline-block rounded bg-primary/20 px-1 text-[10px] font-semibold uppercase tracking-wide">
            ici
          </span>
          &lt;!-- snippet Veridian Analytics --&gt;
        </div>
        <div className="text-muted-foreground/60">&lt;/head&gt;</div>
      </div>

      <ul className="space-y-2.5 text-sm text-muted-foreground">
        <InstallTip>
          Le snippet doit être présent sur <strong>toutes les pages</strong> à
          suivre — placez-le dans le template / layout global de votre site.
        </InstallTip>
        <InstallTip>
          Sur la plupart des CMS (WordPress, Webflow, Shopify…), un champ
          « code dans le <code className="rounded bg-muted/50 px-1">&lt;head&gt;</code> »
          existe dans les réglages du thème.
        </InstallTip>
        <InstallTip>
          Aucune autre configuration : une fois en place, les visites
          remontent automatiquement.
        </InstallTip>
      </ul>

      <a
        href="https://docs.veridian.site/analytics/install"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        data-testid="welcome-docs-link"
      >
        Guide d’installation détaillé
        <ExternalLink className="h-3.5 w-3.5" />
      </a>

      <div className="flex items-center justify-between">
        <SecondaryButton onClick={onBack} testId="welcome-back-2">
          <ArrowLeft className="h-4 w-4" />
          Retour
        </SecondaryButton>
        <PrimaryButton onClick={onNext} testId="welcome-next-2">
          C’est posé, vérifier
          <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
      </div>
    </div>
  );
}

function InstallTip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

// ─── Étape 3 — Vérifier ─────────────────────────────────────────────────────

function StepVerify({
  state,
  timeoutMs,
  onBack,
  onRetry,
}: {
  state: VerifyState;
  timeoutMs: number;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-5" data-testid="welcome-step-verify">
      <StepTitle
        icon={ClipboardCheck}
        title="Vérification"
        subtitle="Nous écoutons votre site. Dès qu’une première visite arrive, vous êtes redirigé vers votre dashboard."
      />

      {state.kind === 'polling' && (
        <VerifyPanel
          testId="welcome-verify-waiting"
          tone="waiting"
          icon={<Loader2 className="h-7 w-7 animate-spin" />}
          title="On attend le premier événement…"
          body={
            <>
              Ouvrez votre site dans un nouvel onglet pour générer une visite.
              {' '}
              <span className="tabular-nums text-muted-foreground/70">
                ({formatElapsed(state.elapsedMs)} / {formatElapsed(timeoutMs)})
              </span>
            </>
          }
        />
      )}

      {state.kind === 'ok' && (
        <VerifyPanel
          testId="welcome-verify-ok"
          tone="ok"
          icon={<CheckCircle2 className="h-7 w-7" />}
          title="Premier pageview reçu !"
          body={
            <>
              Votre tracker fonctionne.
              {state.firstSeenAt && (
                <>
                  {' '}Première visite détectée le{' '}
                  {formatFirstSeen(state.firstSeenAt)}.
                </>
              )}{' '}
              Redirection vers votre dashboard…
            </>
          }
        />
      )}

      {state.kind === 'timeout' && (
        <VerifyPanel
          testId="welcome-verify-timeout"
          tone="warn"
          icon={<RefreshCw className="h-7 w-7" />}
          title="On ne reçoit rien pour l’instant"
          body={
            <>
              Vérifiez que le snippet est bien collé dans le{' '}
              <code className="rounded bg-muted/50 px-1">&lt;head&gt;</code> de
              votre site, et qu’il est publié en ligne. Puis relancez la
              vérification.
            </>
          }
        />
      )}

      {state.kind === 'error' && (
        <VerifyPanel
          testId="welcome-verify-error"
          tone="warn"
          icon={<RefreshCw className="h-7 w-7" />}
          title="Vérification impossible"
          body={
            <>
              {state.error instanceof BridgeApiError &&
              (state.error.status === 401 || state.error.status === 403)
                ? "Votre session n’a pas les droits pour vérifier ce workspace. Reconnectez-vous ou contactez Robert."
                : 'Le service de vérification est momentanément indisponible. Réessayez dans quelques instants.'}
            </>
          }
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SecondaryButton onClick={onBack} testId="welcome-back-3">
          <ArrowLeft className="h-4 w-4" />
          Revoir l’installation
        </SecondaryButton>

        <div className="flex items-center gap-2">
          {(state.kind === 'timeout' || state.kind === 'error') && (
            <>
              <a
                href={helpMailto()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                data-testid="welcome-help-button"
              >
                <LifeBuoy className="h-4 w-4" />
                Aide
              </a>
              <PrimaryButton onClick={onRetry} testId="welcome-retry-button">
                <RefreshCw className="h-4 w-4" />
                Refaire le check
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VerifyPanel({
  testId,
  tone,
  icon,
  title,
  body,
}: {
  testId: string;
  tone: 'waiting' | 'ok' | 'warn';
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  const toneClass =
    tone === 'ok'
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-primary/30 bg-primary/10 text-primary';
  return (
    <div
      className="veridian-fade-in flex flex-col items-center gap-4 rounded-lg border border-border/60 bg-background/40 px-6 py-10 text-center"
      data-testid={testId}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'flex h-14 w-14 items-center justify-center rounded-full border',
          toneClass,
        )}
      >
        {icon}
      </div>
      <div className="max-w-sm space-y-1.5">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

// ─── Primitives partagées ───────────────────────────────────────────────────

function StepTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

function PrimaryButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground',
        'transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-border/70 px-3.5 py-2 text-sm font-medium text-muted-foreground',
        'transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFirstSeen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function helpMailto(): string {
  return `mailto:contact@veridian.site?subject=${encodeURIComponent(
    'Veridian Analytics — aide installation du tracker',
  )}&body=${encodeURIComponent(
    `Bonjour Robert,\n\nJ'ai posé le snippet Veridian sur mon site mais la vérification ne détecte aucune visite.\nPouvez-vous m'aider ?\n\n--\nEnvoyé depuis l'onboarding Veridian`,
  )}`;
}
