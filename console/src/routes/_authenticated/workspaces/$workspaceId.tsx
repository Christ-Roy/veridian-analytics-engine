import { useState, useRef, useEffect } from 'react'
import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useSuspenseQuery, useQuery } from '@tanstack/react-query'
import { Select, Button, Avatar, Spin, Space, Popover, Tooltip, App, Dropdown } from 'antd'
import type { RefSelectProps } from 'antd/es/select'
import { LogoutOutlined, PlusOutlined, GlobalOutlined, QuestionCircleOutlined, MenuOutlined, CloseOutlined, LeftOutlined, RightOutlined, ExclamationCircleOutlined, UserOutlined } from '@ant-design/icons'
import { ExternalLink } from 'lucide-react'
import { workspacesQueryOptions, workspaceQueryOptions, backfillSummaryQueryOptions } from '../../../lib/queries'
import { api } from '../../../lib/api'
import { SyncStatusIcon } from '../../../components/layout/SyncStatusIcon'
import { AssistantProvider } from '../../../contexts/AssistantContext'
import { AssistantButton, AssistantPanel } from '../../../components/Assistant'
import { useAuth } from '../../../lib/useAuth'
import { useTimezone } from '../../../hooks/useTimezone'
import { BRAND, DISPLAY_VERSION } from '../../../config/brand'
import {
  WorkspaceBrandingEffect,
  WorkspaceBrandingProvider,
  brandLogo,
} from '../../../veridian/branding'
import { isFeatureEnabled } from '../../../veridian/features'
import type { DatePreset } from '../../../types/analytics'
import type { WorkspaceSearch, ComparisonMode } from '../../../types/dashboard'

export const Route = createFileRoute('/_authenticated/workspaces/$workspaceId')({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
    // Shared params (dashboard + explore)
    period: (search.period as DatePreset) || undefined,
    timezone: (search.timezone as string) || undefined,
    comparison: (search.comparison as ComparisonMode) || undefined,
    customStart: (search.customStart as string) || undefined,
    customEnd: (search.customEnd as string) || undefined,
    // Explore-specific params
    dimensions: (search.dimensions as string) || undefined,
    filters: (search.filters as string) || undefined,
    minSessions: (search.minSessions as string) || undefined,
  }),
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(workspacesQueryOptions),
      context.queryClient.ensureQueryData(workspaceQueryOptions(params.workspaceId)),
      context.queryClient.ensureQueryData(backfillSummaryQueryOptions(params.workspaceId)),
    ])
  },
  component: WorkspaceLayout,
  pendingComponent: () => (
    <div className="flex-1 flex items-center justify-center">
      <Spin size="large" />
    </div>
  ),
})

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams()
  const { data: workspaces } = useSuspenseQuery(workspacesQueryOptions)
  const { data: workspace } = useSuspenseQuery(workspaceQueryOptions(workspaceId))
  const { logout, user, isDemo } = useAuth()
  // Current user's role in this workspace — gates the owner-only "Zone
  // dangereuse" settings tab in the mobile menu, mirroring the desktop page.
  const { data: members = [] } = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.members.list(workspaceId),
  })
  const isOwner =
    (members.find((m) => m.user_id === user?.id)?.role ?? 'viewer') === 'owner'
  const { message } = App.useApp()
  const { timezone, setTimezone, workspaceTimezone } = useTimezone(workspace.timezone)
  const navigate = useNavigate()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileMenuLevel, setMobileMenuLevel] = useState<'main' | 'settings'>('main')
  const timezoneSelectRef = useRef<RefSelectProps>(null)

  // Focus the Select search input when popover opens
  useEffect(() => {
    if (timezonePopoverOpen && timezoneSelectRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        timezoneSelectRef.current?.focus()
      }, 0)
    }
  }, [timezonePopoverOpen])

  // 🔴 ONBOARDING NON BLOQUANT (figé Robert 2026-06-24) : on NE redirige PLUS
  // de force vers `/welcome` quand le workspace n'a pas encore reçu d'event.
  // L'ancienne logique séquestrait le nouveau client hors de son dashboard tant
  // qu'aucune visite n'arrivait — mauvaise première impression. Désormais le
  // dashboard est accessible immédiatement ; l'install du tracker est proposée
  // en encart dismissable (OnboardingBanner) + via le lien « Démarrage ».
  const isWorkspaceActive = workspace.status === 'active'

  // Build timezone options with workspace timezone first, then all IANA timezones
  const allTimezones = Intl.supportedValuesOf('timeZone')
  const timezoneOptions = [
    { value: workspaceTimezone, label: workspaceTimezone },
    ...allTimezones.filter((tz) => tz !== workspaceTimezone).map((tz) => ({
      value: tz,
      label: tz,
    })),
  ]

  const handleLogout = () => {
    logout()
    navigate({ to: '/login' })
  }

  const handleWorkspaceChange = (id: string) => {
    if (id === 'new') {
      navigate({ to: '/workspaces/new' })
    } else {
      navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: id } })
    }
  }

  // Mirror EXACTLY the desktop Settings page menu (settings.tsx `menuItems`):
  // same keys, same order, same gating (feature flags + ownerOnly). The mobile
  // sub-menu previously omitted privacy / connectors / danger, so a client with
  // the Connecteurs option could not reach it on mobile (vague-2 regression).
  const settingsMenuItems: {
    key:
      | 'workspace'
      | 'dimensions'
      | 'team'
      | 'integrations'
      | 'smtp'
      | 'api-keys'
      | 'privacy'
      | 'sdk'
      | 'voip'
      | 'search-console'
      | 'connectors'
      | 'danger'
    label: string
    feature?: 'voip' | 'gsc' | 'connectors'
    ownerOnly?: boolean
  }[] = [
    { key: 'workspace', label: 'Espace de travail' },
    { key: 'dimensions', label: 'Dimensions personnalisées' },
    { key: 'team', label: 'Équipe' },
    { key: 'integrations', label: 'Intégrations' },
    { key: 'smtp', label: 'Email (SMTP)' },
    { key: 'api-keys', label: 'Clés API' },
    { key: 'privacy', label: 'Confidentialité' },
    { key: 'sdk', label: 'Installer le SDK' },
    { key: 'voip', label: 'Téléphonie / VoIP', feature: 'voip' },
    { key: 'search-console', label: 'Search Console', feature: 'gsc' },
    { key: 'connectors', label: 'Connecteurs', feature: 'connectors' },
    { key: 'danger', label: 'Zone dangereuse', ownerOnly: true },
  ]

  const closeMobileMenu = () => {
    setMobileMenuOpen(false)
    setMobileMenuLevel('main')
  }

  // Per-client white-label logo (defaults to Veridian; never on the demo).
  const logo = brandLogo(workspace, isDemo)

  // Settings tabs visibility — same two filters as the desktop Settings page
  // (settings.tsx): owner-only tabs hidden for non-owners, feature-gated tabs
  // hidden when the option is not subscribed (hidden, never greyed — pricing
  // vision). Keeps the mobile sub-menu a pixel-mirror of the desktop menu.
  const visibleSettingsItems = settingsMenuItems
    .filter((item) => !item.ownerOnly || isOwner)
    .filter((item) => !item.feature || isFeatureEnabled(workspace, item.feature))

  return (
    <AssistantProvider workspaceId={workspaceId}>
    <WorkspaceBrandingProvider workspace={workspace} isDemo={isDemo}>
    <WorkspaceBrandingEffect workspace={workspace} isDemo={isDemo} />
    <div className="flex-1 flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--background)]">
        <div className="h-16 max-w-7xl mx-auto px-4 md:px-6 flex items-center justify-between border-b border-gray-200">
          {/* Mobile: Logo only */}
          <div className="flex md:hidden items-center">
            <Link to="/workspaces/$workspaceId" params={{ workspaceId }}>
              <img src={logo.src} alt={logo.alt} className="h-6 max-w-[140px] object-contain" />
            </Link>
          </div>

          {/* Desktop: Logo + Workspace Selector + Navigation */}
          <div className="hidden md:block">
          <Space size="large">
            <Link to="/workspaces/$workspaceId" params={{ workspaceId }}>
              <img src={logo.src} alt={logo.alt} className="h-6 max-w-[160px] object-contain" />
            </Link>
            <Select
              value={workspaceId}
              onChange={handleWorkspaceChange}
              variant="filled"
              className="min-w-40"
              popupMatchSelectWidth={false}
              labelRender={() => (
                <div className="flex items-center gap-2">
                  <Avatar src={workspace.logo_url} shape="square" size={20}>
                    {workspace.name[0]}
                  </Avatar>
                  <span className="text-gray-800">{workspace.name}</span>
                </div>
              )}
              options={[
                ...workspaces.map((ws) => ({
                  value: ws.id,
                  label: (
                    <div className="flex items-center gap-2">
                      <Avatar src={ws.logo_url} shape="square" size={20}>
                        {ws.name[0]}
                      </Avatar>
                      <span>{ws.name}</span>
                    </div>
                  ),
                })),
                // Only show "New workspace" option for super admins
                ...(user?.isSuperAdmin ? [{
                  value: 'new',
                  label: (
                    <div className="flex items-center gap-2 text-[var(--primary)]">
                      <PlusOutlined />
                      <span>Nouvel espace de travail</span>
                    </div>
                  ),
                }] : []),
              ]}
            />
            {/* Nav staminads complète — TOUJOURS affichée (onboarding non
                bloquant). Le lien « Démarrage » n'apparaît que tant que le
                workspace n'a pas reçu d'event, en tête de nav, sans masquer
                le reste. */}
            <div className="flex items-center">
              <div className="h-5 w-px bg-gray-200" />
              <nav className="flex gap-1 pl-2">
                {!isWorkspaceActive && (
                  <Link
                    to="/workspaces/$workspaceId/welcome"
                    params={{ workspaceId }}
                    className={`px-4 py-2 rounded transition-colors ${
                      currentPath.endsWith('/welcome')
                        ? '!text-[var(--primary)] bg-white'
                        : '!text-gray-500 hover:!text-[var(--primary)]'
                    }`}
                  >
                    Démarrage
                  </Link>
                )}
                {[
                  { to: '/workspaces/$workspaceId', label: 'Tableau de bord', exact: true },
                  { to: '/workspaces/$workspaceId/live', label: 'En direct' },
                  { to: '/workspaces/$workspaceId/explore', label: 'Explorer' },
                  { to: '/workspaces/$workspaceId/goals', label: 'Objectifs' },
                  { to: '/workspaces/$workspaceId/filters', label: 'Filtres' },
                  { to: '/workspaces/$workspaceId/annotations', label: 'Annotations' },
                  { to: '/workspaces/$workspaceId/settings', label: 'Paramètres' },
                ].map(({ to, label, exact }) => {
                  const resolvedPath = to.replace('$workspaceId', workspaceId)
                  const isActive = exact
                    ? currentPath === resolvedPath
                    : currentPath.startsWith(resolvedPath)
                  return (
                    <Link
                      key={to}
                      to={to}
                      params={{ workspaceId }}
                      className={`px-4 py-2 rounded transition-colors ${
                        isActive
                          ? '!text-[var(--primary)] bg-white'
                          : '!text-gray-500 hover:!text-[var(--primary)]'
                      }`}
                    >
                      {label}
                    </Link>
                  )
                })}
              </nav>
            </div>
          </Space>
          </div>

          {/* Mobile: Sync + Hamburger */}
          <div className="flex md:hidden items-center gap-2">
            <SyncStatusIcon workspaceId={workspaceId} />
            <Button
              type="text"
              icon={<MenuOutlined />}
              onClick={() => setMobileMenuOpen(true)}
              className="!text-gray-600"
            />
          </div>

          {/* Desktop: Sync Status + Timezone + Logout */}
          <div className="hidden md:block">
          <Space>
                <SyncStatusIcon workspaceId={workspaceId} />
                <Tooltip title={`Fuseau horaire : ${timezone}`} placement="left">
                  <Popover
                    open={timezonePopoverOpen}
                    onOpenChange={setTimezonePopoverOpen}
                    trigger="click"
                    placement="bottom"
                    destroyOnHidden
                    content={
                      <Select
                        ref={timezoneSelectRef}
                        value={timezone}
                        onChange={(value) => {
                          setTimezone(value)
                          setTimezonePopoverOpen(false)
                          message.success(`Fuseau horaire défini sur ${value}`)
                        }}
                        variant="filled"
                        className="w-48"
                        showSearch
                        popupMatchSelectWidth={false}
                        optionFilterProp="label"
                        options={timezoneOptions}
                        open={timezonePopoverOpen}
                        onOpenChange={(open) => {
                          if (!open) setTimezonePopoverOpen(false)
                        }}
                        getPopupContainer={(trigger) => trigger.parentElement!}
                      />
                    }
                  >
                    <Button
                      type="text"
                      icon={<GlobalOutlined />}
                      className="!text-gray-500 hover:!text-gray-800 hover:!bg-gray-100"
                    />
                  </Popover>
                </Tooltip>
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'documentation',
                    icon: <QuestionCircleOutlined />,
                    label: (
                      <a href={BRAND.docsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                        Documentation
                        <ExternalLink size={12} className="text-gray-400" />
                      </a>
                    ),
                  },
                  {
                    key: 'report-issue',
                    icon: <ExclamationCircleOutlined />,
                    label: (
                      <a href={BRAND.issuesUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                        Signaler un problème
                        <ExternalLink size={12} className="text-gray-400" />
                      </a>
                    ),
                  },
                  { type: 'divider' },
                  {
                    key: 'version',
                    label: `v${DISPLAY_VERSION}`,
                    disabled: true,
                  },
                ],
              }}
              placement="bottomRight"
            >
              <Button
                type="text"
                icon={<QuestionCircleOutlined />}
                className="!text-gray-500 hover:!text-gray-800 hover:!bg-gray-100"
              />
            </Dropdown>
            {!isDemo && (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'account',
                      icon: <UserOutlined />,
                      label: 'Compte',
                      onClick: () => navigate({ to: '/workspaces/$workspaceId/account', params: { workspaceId } }),
                    },
                    { type: 'divider' },
                    {
                      key: 'logout',
                      icon: <LogoutOutlined />,
                      label: 'Déconnexion',
                      onClick: handleLogout,
                    },
                  ],
                }}
                placement="bottomRight"
              >
                <Button
                  type="text"
                  icon={<UserOutlined />}
                  className="!text-gray-500 hover:!text-gray-800 hover:!bg-gray-100"
                />
              </Dropdown>
            )}
          </Space>
          </div>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={closeMobileMenu}
        />
      )}

      {/* Mobile Menu Panel */}
      <div
        className={`fixed inset-y-0 left-[calc(100vw-18rem)] w-72 bg-white z-50 transform transition-transform duration-300 ease-in-out md:hidden overflow-y-auto ${
          mobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Close button */}
        <div className="flex justify-end p-4 border-b border-gray-200">
          <Button
            type="text"
            icon={<CloseOutlined />}
            onClick={closeMobileMenu}
          />
        </div>

        {/* Workspace Selector */}
          <div className="p-4 border-b border-gray-200">
            <Select
              value={workspaceId}
              onChange={(id) => {
                handleWorkspaceChange(id)
                closeMobileMenu()
              }}
              variant="filled"
              className="w-full"
              popupMatchSelectWidth={false}
              labelRender={() => (
                <div className="flex items-center gap-2">
                  <Avatar src={workspace.logo_url} shape="square" size={20}>
                    {workspace.name[0]}
                  </Avatar>
                  <span className="text-gray-800">{workspace.name}</span>
                </div>
              )}
              options={[
                ...workspaces.map((ws) => ({
                  value: ws.id,
                  label: (
                    <div className="flex items-center gap-2">
                      <Avatar src={ws.logo_url} shape="square" size={20}>
                        {ws.name[0]}
                      </Avatar>
                      <span>{ws.name}</span>
                    </div>
                  ),
                })),
                ...(user?.isSuperAdmin ? [{
                  value: 'new',
                  label: (
                    <div className="flex items-center gap-2 text-[var(--primary)]">
                      <PlusOutlined />
                      <span>Nouvel espace de travail</span>
                    </div>
                  ),
                }] : []),
              ]}
            />
          </div>

          {/* Navigation Links — nav staminads complète TOUJOURS affichée
              (onboarding non bloquant). Le lien « Démarrage » n'apparaît que
              tant que le workspace n'a pas reçu d'event. */}
          <nav className="flex flex-col py-2">
              {mobileMenuLevel === 'main' ? (
                <>
                  {!isWorkspaceActive && (
                    <Link
                      to="/workspaces/$workspaceId/welcome"
                      params={{ workspaceId }}
                      onClick={closeMobileMenu}
                      className={`px-4 py-3 transition-colors ${
                        currentPath.endsWith('/welcome')
                          ? '!text-[var(--primary)] bg-purple-50'
                          : '!text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Démarrage
                    </Link>
                  )}
                  {[
                    { to: '/workspaces/$workspaceId', label: 'Tableau de bord', exact: true },
                    { to: '/workspaces/$workspaceId/live', label: 'En direct' },
                    { to: '/workspaces/$workspaceId/explore', label: 'Explorer' },
                    { to: '/workspaces/$workspaceId/goals', label: 'Objectifs' },
                    { to: '/workspaces/$workspaceId/filters', label: 'Filtres' },
                    { to: '/workspaces/$workspaceId/annotations', label: 'Annotations' },
                  ].map(({ to, label, exact }) => {
                    const resolvedPath = to.replace('$workspaceId', workspaceId)
                    const isActive = exact
                      ? currentPath === resolvedPath
                      : currentPath.startsWith(resolvedPath)
                    return (
                      <Link
                        key={to}
                        to={to}
                        params={{ workspaceId }}
                        onClick={closeMobileMenu}
                        className={`px-4 py-3 transition-colors ${
                          isActive
                            ? '!text-[var(--primary)] bg-purple-50'
                            : '!text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </Link>
                    )
                  })}
                  <button
                    onClick={() => setMobileMenuLevel('settings')}
                    className={`flex items-center justify-between px-4 py-3 transition-colors w-full text-left ${
                      currentPath.includes('/settings')
                        ? '!text-[var(--primary)] bg-purple-50'
                        : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Paramètres
                    <RightOutlined className="text-gray-400" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setMobileMenuLevel('main')}
                    className="flex items-center gap-2 px-4 py-3 text-gray-700 hover:bg-gray-50 w-full text-left border-b border-gray-200"
                  >
                    <LeftOutlined />
                    Retour
                  </button>
                  {visibleSettingsItems.map((item) => (
                    <Link
                      key={item.key}
                      to="/workspaces/$workspaceId/settings"
                      params={{ workspaceId }}
                      search={{ section: item.key }}
                      onClick={closeMobileMenu}
                      className="px-4 py-3 text-gray-700 hover:bg-gray-50 block"
                    >
                      {item.label}
                    </Link>
                  ))}
                </>
              )}
          </nav>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Timezone Picker */}
          <div className="p-4">
            <div className="text-xs text-gray-500 mb-2">Fuseau horaire</div>
            <Select
              value={timezone}
              onChange={(value) => {
                setTimezone(value)
                message.success(`Fuseau horaire défini sur ${value}`)
              }}
              variant="filled"
              className="w-full"
              showSearch
              optionFilterProp="label"
              options={timezoneOptions}
            />
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Help Links */}
          <div className="py-2">
            <a
              href={BRAND.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 text-gray-700 hover:bg-gray-50"
            >
              <QuestionCircleOutlined />
              <span className="flex-1">Documentation</span>
              <ExternalLink size={12} className="text-gray-400" />
            </a>
            <a
              href={BRAND.issuesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 text-gray-700 hover:bg-gray-50"
            >
              <ExclamationCircleOutlined />
              <span className="flex-1">Signaler un problème</span>
              <ExternalLink size={12} className="text-gray-400" />
            </a>
            <div className="px-4 py-2 text-xs text-gray-400">
              v{DISPLAY_VERSION}
            </div>
          </div>

          {!isDemo && (
            <>
              {/* Divider */}
              <div className="border-t border-gray-200" />

              {/* Account */}
              <Link
                to="/workspaces/$workspaceId/account"
                params={{ workspaceId }}
                onClick={closeMobileMenu}
                className="flex items-center gap-3 px-4 py-3 text-gray-700 hover:bg-gray-50"
              >
                <UserOutlined />
                Compte
              </Link>

              {/* Logout */}
              <button
                onClick={() => {
                  closeMobileMenu()
                  handleLogout()
                }}
                className="flex items-center gap-3 px-4 py-3 text-gray-700 hover:bg-gray-50 w-full text-left"
              >
                <LogoutOutlined />
                Déconnexion
              </button>
            </>
          )}
      </div>

      <div className="flex-1">
        <div className="max-w-7xl mx-auto">
          <Outlet />
        </div>
      </div>

      {/* AI Assistant - available on all workspace pages */}
      <AssistantButton />
      <AssistantPanel />
    </div>
    </WorkspaceBrandingProvider>
    </AssistantProvider>
  )
}
