import {
  WORKSPACE_TEMPLATE_IDS,
  WORKSPACE_TEMPLATES,
  getWorkspaceTemplate,
  isWorkspaceTemplateId,
} from './workspace-templates';
import { DASHBOARD_WIDGET_KEYS } from '../../common/validators/dashboard-widget.validator';

/**
 * Unit guards on the provisioning template catalogue. Pure data — no ClickHouse.
 * The point: a preset must stay WITHIN the native contracts the rest of the
 * engine validates (widget keys, branding hex, CRM identity resolver), so a
 * provisioned workspace never carries a config the M2M set* verbs would reject.
 */
describe('workspace-templates (provisioning presets)', () => {
  const WIDGET_SET = new Set<string>(DASHBOARD_WIDGET_KEYS);

  it('exposes exactly the three documented template ids', () => {
    expect([...WORKSPACE_TEMPLATE_IDS].sort()).toEqual([
      'ecommerce',
      'vitrine',
      'webapp',
    ]);
  });

  describe.each(WORKSPACE_TEMPLATE_IDS)('preset "%s"', (id) => {
    const preset = WORKSPACE_TEMPLATES[id];

    it('has a valid hex accent color', () => {
      expect(preset.branding.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('declares all three feature flags as booleans', () => {
      expect(typeof preset.features.voip).toBe('boolean');
      expect(typeof preset.features.gsc).toBe('boolean');
      expect(typeof preset.features.connectors).toBe('boolean');
    });

    it('orders ONLY known native widgets, with no duplicates and no hiding', () => {
      const order = preset.dashboard_layout.order ?? [];
      // Every key is a known native widget (would otherwise 400 in setLayout).
      for (const key of order) expect(WIDGET_SET.has(key)).toBe(true);
      // No duplicate keys.
      expect(new Set(order).size).toBe(order.length);
      // Vision 2026-05-23: générosité, presets never HIDE a widget.
      expect(preset.dashboard_layout.hidden_widgets).toBeUndefined();
    });

    it('uses a valid identity_resolver and goal match grammar', () => {
      const crm = preset.crm_mapping;
      expect(['auto', 'email', 'field']).toContain(crm.identity_resolver);
      expect(typeof crm.map_phone_calls).toBe('boolean');
      for (const rule of crm.goals ?? []) {
        // The mapper parses match as `goal:<name>` or `screen_view:<prefix>`.
        expect(rule.match).toMatch(/^(goal|screen_view):.+/);
        expect(rule.timeline_name.length).toBeGreaterThan(0);
      }
    });
  });

  it('VoIP is ON only for the vitrine template (phone = its conversion channel)', () => {
    expect(WORKSPACE_TEMPLATES.vitrine.features.voip).toBe(true);
    expect(WORKSPACE_TEMPLATES.ecommerce.features.voip).toBe(false);
    expect(WORKSPACE_TEMPLATES.webapp.features.voip).toBe(false);
  });

  it('webapp resolves identity by email and emits no phone milestone', () => {
    expect(WORKSPACE_TEMPLATES.webapp.crm_mapping.identity_resolver).toBe(
      'email',
    );
    expect(WORKSPACE_TEMPLATES.webapp.crm_mapping.map_phone_calls).toBe(false);
  });

  describe('getWorkspaceTemplate / isWorkspaceTemplateId', () => {
    it('resolves a known id to its preset', () => {
      expect(getWorkspaceTemplate('ecommerce')).toBe(
        WORKSPACE_TEMPLATES.ecommerce,
      );
    });

    it('returns undefined for absent or unknown template (no preset applied)', () => {
      expect(getWorkspaceTemplate(undefined)).toBeUndefined();
      expect(getWorkspaceTemplate('')).toBeUndefined();
      expect(getWorkspaceTemplate('ecom')).toBeUndefined();
    });

    it('isWorkspaceTemplateId narrows correctly', () => {
      expect(isWorkspaceTemplateId('vitrine')).toBe(true);
      expect(isWorkspaceTemplateId('nope')).toBe(false);
      expect(isWorkspaceTemplateId(42)).toBe(false);
    });
  });
});
