import type {
  WorkspaceBranding,
  WorkspaceFeatures,
  DashboardLayout,
  WorkspaceCrmMapping,
} from '../../workspaces/entities/workspace.entity';

/**
 * Provisioning templates — per-industry presets applied at `provisionTenant()`.
 *
 * WHY this exists. The customization backend (setBranding / setFeatures /
 * setLayout / crm.setMapping → blob JSON `settings`, zero-migration) was already
 * complete; the ONLY gap was that `provisionTenant()` injected NO preset, so
 * every fresh workspace started identical (vision figée 2026-05-23: customise the
 * native staminads app, don't rewrite it). A template is just a BUNDLE of values
 * pushed once at creation through the same `workspacesService.update({ settings })`
 * path the M2M `set*` verbs use. Pure data — zero new infra, zero new route.
 *
 * SCOPE (vision 2026-05-23, do NOT extend without Robert):
 *   - branding.color        → console accent color (white-label)
 *   - features              → Settings tab visibility (voip/gsc/connectors)
 *   - dashboard_layout      → REORDER native widgets (never hide — générosité,
 *                             pas de mur béton; on n'ajoute aucun widget custom)
 *   - crm_mapping           → the Twenty funnel adapted to the client's industry
 * A template NEVER creates a page/route, NEVER hides a widget, NEVER masks a
 * native Settings tab beyond the 3 feature flags. Omitting `--template` at
 * provisioning = NO preset = strictly the current (back-compat) behaviour.
 *
 * The widget keys below MUST stay within the closed native set
 * (`DASHBOARD_WIDGET_KEYS`): pages, sources, campaigns, countries, heatmap,
 * devices, page_views, goals. The CRM `goals[].match` use the real goal-name
 * vocabulary tracked by client sites (purchase / add_to_cart / checkout_start /
 * reservation_confirmed / appointment_click / rdv_booked / form_submission /
 * signup / app_started / newsletter_signup / phone_call).
 */

/** The closed set of provisioning template ids. */
export const WORKSPACE_TEMPLATE_IDS = [
  'ecommerce',
  'vitrine',
  'webapp',
] as const;

export type WorkspaceTemplateId = (typeof WORKSPACE_TEMPLATE_IDS)[number];

/**
 * A template preset = the three customization sub-objects pushed verbatim into
 * `settings` at provisioning. Each is deep-merged over the workspace defaults
 * (which carry none of these keys), so applying a preset only ADDS config.
 */
export interface WorkspaceTemplatePreset {
  branding: WorkspaceBranding;
  features: WorkspaceFeatures;
  dashboard_layout: DashboardLayout;
  crm_mapping: WorkspaceCrmMapping;
}

/**
 * E-COMMERCE — boutique en ligne.
 *
 * Conversion happens online: VoIP OFF (no phone funnel), GSC ON (product SEO
 * traffic matters), connectors ON. Dashboard ordered conversion-first (goals on
 * top). CRM funnel = the purchase journey (panier → checkout → achat) plus the
 * newsletter capture; phone calls still surface (a call is a signal even online).
 */
const ECOMMERCE: WorkspaceTemplatePreset = {
  branding: { color: '#2563eb' },
  features: { voip: false, gsc: true, connectors: true },
  dashboard_layout: {
    order: [
      'goals',
      'pages',
      'sources',
      'campaigns',
      'devices',
      'countries',
      'page_views',
      'heatmap',
    ],
  },
  crm_mapping: {
    identity_resolver: 'auto',
    map_phone_calls: true,
    phone_call_timeline_name: 'appel',
    goals: [
      { match: 'goal:add_to_cart', timeline_name: 'panier' },
      { match: 'goal:checkout_start', timeline_name: 'checkout' },
      { match: 'goal:purchase', timeline_name: 'achat' },
      { match: 'goal:newsletter_signup', timeline_name: 'newsletter' },
    ],
  },
};

/**
 * VITRINE — site vitrine local (resto, artisan, cabinet…).
 *
 * The phone is THE conversion channel (Analytics feature #2 = Calls): VoIP ON,
 * GSC ON (local SEO is critical), connectors ON. Dashboard ordered around
 * sources/contact. CRM funnel = the contact/rdv/appel journey; phone calls are
 * the heart of the funnel here.
 */
const VITRINE: WorkspaceTemplatePreset = {
  branding: { color: '#0d9488' },
  features: { voip: true, gsc: true, connectors: true },
  dashboard_layout: {
    order: [
      'goals',
      'sources',
      'pages',
      'countries',
      'devices',
      'campaigns',
      'page_views',
      'heatmap',
    ],
  },
  crm_mapping: {
    identity_resolver: 'auto',
    map_phone_calls: true,
    phone_call_timeline_name: 'appel',
    goals: [
      { match: 'goal:appointment_click', timeline_name: 'demande_rdv' },
      { match: 'goal:rdv_booked', timeline_name: 'rdv_confirme' },
      { match: 'goal:form_submission', timeline_name: 'contact' },
    ],
  },
};

/**
 * WEBAPP — SaaS / application web.
 *
 * No phone funnel: VoIP OFF, GSC ON (content/SEO acquisition), connectors ON.
 * Default Veridian accent (SaaS is our own core product). Dashboard ordered
 * acquisition → activation (sources first). CRM funnel = signup → activation,
 * resolved by email (a SaaS identifies its users by email at signup — more
 * reliable than `auto`); phone calls OFF (a SaaS has no phone funnel).
 */
const WEBAPP: WorkspaceTemplatePreset = {
  branding: { color: '#7763f1' },
  features: { voip: false, gsc: true, connectors: true },
  dashboard_layout: {
    order: [
      'sources',
      'goals',
      'campaigns',
      'pages',
      'devices',
      'page_views',
      'countries',
      'heatmap',
    ],
  },
  crm_mapping: {
    identity_resolver: 'email',
    map_phone_calls: false,
    goals: [
      { match: 'goal:signup', timeline_name: 'inscription' },
      { match: 'goal:app_started', timeline_name: 'activation' },
    ],
  },
};

/** The frozen preset catalogue, keyed by template id. */
export const WORKSPACE_TEMPLATES: Record<
  WorkspaceTemplateId,
  WorkspaceTemplatePreset
> = {
  ecommerce: ECOMMERCE,
  vitrine: VITRINE,
  webapp: WEBAPP,
};

/** Type guard — true when `value` is a known template id. */
export function isWorkspaceTemplateId(
  value: unknown,
): value is WorkspaceTemplateId {
  return (
    typeof value === 'string' &&
    (WORKSPACE_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a template id to its preset, or `undefined` when no template was
 * requested (→ provisioning applies no preset = current behaviour).
 */
export function getWorkspaceTemplate(
  template?: string,
): WorkspaceTemplatePreset | undefined {
  if (!template) return undefined;
  return isWorkspaceTemplateId(template)
    ? WORKSPACE_TEMPLATES[template]
    : undefined;
}
