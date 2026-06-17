import { GscService } from './gsc.service';
import { GscOauthService, GscSiteEntry } from './gsc-oauth.service';
import { GscSyncService } from './gsc-sync.service';
import { GscRepository } from './gsc.repository';
import { GscTokenCrypto } from './gsc-token-crypto';
import { GscProperty, GscOauthTokens } from './entities/gsc-property.entity';

const TOKENS: GscOauthTokens = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: Date.now() + 3_600_000,
  scope: 's',
  token_type: 'Bearer',
};

function makeProperty(over: Partial<GscProperty> = {}): GscProperty {
  return {
    id: 'gsc_1',
    workspace_id: 'ws_1',
    site_url: 'sc-domain:exemple.fr',
    ownership_state: 'verified',
    oauth_tokens_encrypted: 'enc',
    last_sync_at: '2026-06-01 00:00:00.000',
    created_at: '2026-01-01 00:00:00.000',
    updated_at: '2026-01-01 00:00:00.000',
    deleted_at: null,
    ...over,
  };
}

function build(overrides: {
  sites?: GscSiteEntry[];
  prop?: GscProperty | null;
} = {}) {
  const oauth = {
    parseState: jest.fn(() => 'ws_1'),
    exchangeCode: jest.fn(async () => TOKENS),
    listSites: jest.fn(async () => overrides.sites ?? []),
    buildAuthUrl: jest.fn(() => 'https://accounts.google.com/...'),
    isConfigured: jest.fn(() => true),
  } as unknown as GscOauthService;
  const sync = {
    syncProperty: jest.fn(async () => ({
      gscPropertyId: 'gsc_1',
      range: { start: '', end: '' },
      searchTypes: ['web'],
      upserted: 0,
      errors: [],
    })),
  } as unknown as GscSyncService;
  const repo = {
    upsertProperty: jest.fn(async () => makeProperty()),
    findPropertyByWorkspace: jest.fn(async () =>
      overrides.prop === undefined ? makeProperty() : overrides.prop,
    ),
    softDelete: jest.fn(async () => {}),
    findVerifiedProperties: jest.fn(async () => []),
  } as unknown as jest.Mocked<GscRepository>;
  const crypto = {
    encryptTokens: jest.fn(() => 'enc'),
    decryptTokens: jest.fn(() => TOKENS),
  } as unknown as GscTokenCrypto;
  return {
    svc: new GscService(oauth, sync, repo, crypto),
    oauth,
    sync,
    repo,
  };
}

describe('GscService', () => {
  describe('handleCallback', () => {
    it('resolves the site and marks the property verified', async () => {
      const { svc, repo } = build({
        sites: [
          { siteUrl: 'https://exemple.fr/', permissionLevel: 'siteFullUser' },
          { siteUrl: 'sc-domain:exemple.fr', permissionLevel: 'siteOwner' },
        ],
      });
      const r = await svc.handleCallback('code', 'state');
      expect(r.workspaceId).toBe('ws_1');
      // sc-domain (propriété de domaine) prioritaire sur l'URL préfixe.
      expect(r.siteUrl).toBe('sc-domain:exemple.fr');
      expect(repo.upsertProperty).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_1',
          siteUrl: 'sc-domain:exemple.fr',
          ownershipState: 'verified',
        }),
      );
    });

    it('prefers an owned site over a merely-readable one', async () => {
      const { svc } = build({
        sites: [
          { siteUrl: 'https://other.fr/', permissionLevel: 'siteRestrictedUser' },
          { siteUrl: 'https://mine.fr/', permissionLevel: 'siteOwner' },
        ],
      });
      const r = await svc.handleCallback('code', 'state');
      expect(r.siteUrl).toBe('https://mine.fr/');
    });

    it('persists as pending when no site is resolvable', async () => {
      const { svc, repo } = build({ sites: [] });
      const r = await svc.handleCallback('code', 'state');
      expect(r.siteUrl).toBeNull();
      expect(repo.upsertProperty).toHaveBeenCalledWith(
        expect.objectContaining({ ownershipState: 'pending', siteUrl: '' }),
      );
    });

    it('still persists tokens (pending) when sites.list fails', async () => {
      const { svc, oauth, repo } = build();
      (oauth.listSites as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const r = await svc.handleCallback('code', 'state');
      expect(r.siteUrl).toBeNull();
      expect(repo.upsertProperty).toHaveBeenCalledWith(
        expect.objectContaining({ ownershipState: 'pending' }),
      );
    });
  });

  describe('status', () => {
    it('reports connected for a verified property', async () => {
      const { svc } = build({ prop: makeProperty() });
      expect(await svc.status('ws_1')).toEqual({
        connected: true,
        site_url: 'sc-domain:exemple.fr',
        ownership_state: 'verified',
        last_sync_at: '2026-06-01 00:00:00.000',
      });
    });

    it('reports not-connected when no property', async () => {
      const { svc } = build({ prop: null });
      expect(await svc.status('ws_1')).toMatchObject({ connected: false });
    });

    it('reports not-connected for a pending property', async () => {
      const { svc } = build({
        prop: makeProperty({ ownership_state: 'pending', site_url: '' }),
      });
      const s = await svc.status('ws_1');
      expect(s.connected).toBe(false);
      expect(s.ownership_state).toBe('pending');
    });
  });

  describe('resync', () => {
    it('skips when not connected', async () => {
      const { svc, sync } = build({ prop: null });
      const r = await svc.resync('ws_1');
      expect(r).toEqual({ skipped: 'not_connected' });
      expect(sync.syncProperty).not.toHaveBeenCalled();
    });

    it('triggers a sync for a verified property', async () => {
      const { svc, sync } = build({ prop: makeProperty() });
      await svc.resync('ws_1', 30);
      expect(sync.syncProperty).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('soft-deletes an existing property', async () => {
      const { svc, repo } = build({ prop: makeProperty() });
      expect(await svc.disconnect('ws_1')).toEqual({ disconnected: true });
      expect(repo.softDelete).toHaveBeenCalled();
    });

    it('is a no-op when nothing to disconnect', async () => {
      const { svc, repo } = build({ prop: null });
      expect(await svc.disconnect('ws_1')).toEqual({ disconnected: false });
      expect(repo.softDelete).not.toHaveBeenCalled();
    });
  });
});
