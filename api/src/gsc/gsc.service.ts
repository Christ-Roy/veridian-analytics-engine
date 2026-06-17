import { Injectable, Logger } from '@nestjs/common';
import { GscOauthService, GscSiteEntry } from './gsc-oauth.service';
import { GscSyncService, GscSyncResult } from './gsc-sync.service';
import { GscRepository } from './gsc.repository';
import { GscTokenCrypto } from './gsc-token-crypto';
import {
  GscOauthTokens,
  GscProperty,
  PublicGscProperty,
} from './entities/gsc-property.entity';

/**
 * Façade métier du module GSC — port natif de `gsc/index.ts` (bridge).
 *
 * Orchestre OAuth + persistance + sync, masque le repository et la crypto au
 * controller. Les services bas-niveau (oauth, sync, repo, crypto) restent purs
 * et testables ; cette façade colle le flow ensemble :
 *
 *   - beginOauth(workspaceId)   → URL Google consent
 *   - handleCallback(code,state)→ exchange + chiffre + résout le site + verified
 *   - status(workspaceId)       → vue publique (connected / propertyUrl / sync)
 *   - resync(workspaceId)       → sync immédiat (bouton « Resynchroniser »)
 *   - disconnect(workspaceId)   → soft-delete + purge token
 */
@Injectable()
export class GscService {
  private readonly logger = new Logger(GscService.name);

  constructor(
    private readonly oauth: GscOauthService,
    private readonly sync: GscSyncService,
    private readonly repo: GscRepository,
    private readonly crypto: GscTokenCrypto,
  ) {}

  isConfigured(): boolean {
    return this.oauth.isConfigured();
  }

  // ─── OAuth ───────────────────────────────────────────────────────────

  /** URL Google consent à ouvrir côté front pour démarrer la connexion. */
  beginOauth(workspaceId: string): { url: string } {
    return { url: this.oauth.buildAuthUrl(workspaceId) };
  }

  /**
   * Callback Google : valide le state (anti-CSRF), échange le code, chiffre les
   * tokens, résout automatiquement la propriété GSC du workspace et persiste.
   *
   * Résolution du site : on liste les sites du compte ; on prend le premier que
   * l'utilisateur possède (`siteOwner`/`siteFullUser`) — si plusieurs, on
   * privilégie une `sc-domain:` (propriété de domaine, la plus large). Si aucun
   * site exploitable, la property reste `pending` (l'UI proposera un resync).
   */
  async handleCallback(
    code: string,
    state: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ workspaceId: string; siteUrl: string | null }> {
    const workspaceId = this.oauth.parseState(state);
    const tokens = await this.oauth.exchangeCode(code, fetchImpl);

    let siteUrl: string | null = null;
    try {
      const sites = await this.oauth.listSites(tokens.access_token, fetchImpl);
      siteUrl = this.pickSite(sites);
    } catch (e) {
      // La résolution du site est best-effort : si sites.list échoue on
      // persiste quand même les tokens en `pending` pour ne pas perdre le
      // consent — un resync ré-essaiera la résolution.
      this.logger.warn(
        `sites.list failed for workspace ${workspaceId}: ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
    }

    const encrypted = this.crypto.encryptTokens(tokens, workspaceId);
    await this.repo.upsertProperty({
      workspaceId,
      siteUrl: siteUrl ?? '',
      ownershipState: siteUrl ? 'verified' : 'pending',
      oauthTokensEncrypted: encrypted,
    });

    return { workspaceId, siteUrl };
  }

  private pickSite(sites: GscSiteEntry[]): string | null {
    const owned = sites.filter(
      (s) =>
        s.permissionLevel === 'siteOwner' ||
        s.permissionLevel === 'siteFullUser',
    );
    const pool = owned.length > 0 ? owned : sites;
    if (pool.length === 0) return null;
    const domainProp = pool.find((s) => s.siteUrl.startsWith('sc-domain:'));
    return (domainProp ?? pool[0]).siteUrl;
  }

  // ─── Lecture / actions ───────────────────────────────────────────────

  /** Vue publique de l'état GSC d'un workspace (aucun token exposé). */
  async status(workspaceId: string): Promise<PublicGscProperty> {
    const prop = await this.repo.findPropertyByWorkspace(workspaceId);
    if (!prop || prop.ownership_state !== 'verified') {
      return {
        connected: false,
        site_url: prop?.site_url || null,
        ownership_state: prop?.ownership_state ?? null,
        last_sync_at: prop?.last_sync_at ?? null,
      };
    }
    return {
      connected: true,
      site_url: prop.site_url,
      ownership_state: prop.ownership_state,
      last_sync_at: prop.last_sync_at,
    };
  }

  /** Sync immédiat de la property du workspace (bouton resync). */
  async resync(
    workspaceId: string,
    days = 30,
    fetchImpl: typeof fetch = fetch,
  ): Promise<GscSyncResult | { skipped: 'not_connected' }> {
    const prop = await this.repo.findPropertyByWorkspace(workspaceId);
    if (!prop || prop.ownership_state !== 'verified') {
      return { skipped: 'not_connected' };
    }
    return this.sync.syncProperty(prop, { days, fetchImpl });
  }

  /** Déconnexion : soft-delete de la property + purge du token chiffré. */
  async disconnect(workspaceId: string): Promise<{ disconnected: boolean }> {
    const prop = await this.repo.findPropertyByWorkspace(workspaceId);
    if (!prop) return { disconnected: false };
    await this.repo.softDelete(prop);
    return { disconnected: true };
  }

  // Re-export typé pour les tests / le cron.
  async listVerified(): Promise<GscProperty[]> {
    return this.repo.findVerifiedProperties();
  }

  decrypt(prop: GscProperty): GscOauthTokens {
    return this.crypto.decryptTokens(
      prop.oauth_tokens_encrypted,
      prop.workspace_id,
    );
  }
}
