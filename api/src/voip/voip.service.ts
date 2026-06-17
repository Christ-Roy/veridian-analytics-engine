import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { ClickHouseService } from '../database/clickhouse.service';
import { generateId } from '../common/crypto';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import { VoipCrypto } from './voip-crypto.service';
import {
  ClearCreds,
  ConnectionTestResult,
  VOIP_CREDENTIAL_KINDS,
  getProvider,
  kindToProvider,
} from './voip.providers';
import {
  PHONE_NUMBER_SOURCES,
  PhoneSource,
  VoipCredentialKind,
  VoipCredentialStatus,
  isPhoneSource,
} from './voip.types';
import { toE164 } from './phone-e164';
import {
  PhoneNumberEntity,
  PublicPhoneNumber,
  PublicVoipCredential,
  VoipCredential,
} from './entities/voip-credential.entity';

const CREDS_TABLE = 'voip_credentials';
const NUMBERS_TABLE = 'tenant_phone_numbers';

interface CredRow {
  id: string;
  workspace_id: string;
  kind: string;
  creds_encrypted: string;
  status: string;
  last_sync_at: string | null;
  last_tested_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface NumberRow {
  id: string;
  workspace_id: string;
  e164: string;
  source: string;
  label: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

@Injectable()
export class VoipService {
  private readonly logger = new Logger(VoipService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly crypto: VoipCrypto,
  ) {}

  // ─── Credentials ──────────────────────────────────────────────────

  /**
   * Enregistre (ou remplace) un credential VoIP. La saisie est validée par le
   * schéma Zod du provider, chiffrée par workspace, puis upsertée. Le
   * ReplacingMergeTree((workspace_id, kind)) garantit qu'un même kind ne vit
   * qu'en un exemplaire (le dernier `updated_at` gagne).
   */
  async saveCredential(
    workspaceId: string,
    kind: VoipCredentialKind,
    rawCreds: Record<string, unknown>,
  ): Promise<PublicVoipCredential> {
    const provider = getProvider(kind);
    let parsed: ClearCreds;
    try {
      parsed = provider.parse(rawCreds);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          code: 'INVALID_CREDS',
          message: `Identifiants ${provider.label} invalides : ${err.issues
            .map((i) => `${i.path.join('.') || 'creds'} ${i.message}`)
            .join('; ')}`,
        });
      }
      throw err;
    }

    const existing = await this.findCredential(workspaceId, kind);
    const now = toClickHouseDateTime();
    const cred: VoipCredential = {
      id: existing?.id ?? `voip_${generateId().replace(/-/g, '').slice(0, 22)}`,
      workspace_id: workspaceId,
      kind,
      creds_encrypted: this.crypto.encryptCreds(
        JSON.stringify(parsed),
        workspaceId,
      ),
      // Nouvelle saisie → on repart sur "untested" tant que la connexion n'a
      // pas été vérifiée (le test passe le statut à ok/failed).
      status: 'untested',
      last_sync_at: existing?.last_sync_at ?? null,
      last_tested_at: null,
      last_error: '',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
    };
    await this.clickhouse.insertSystem(CREDS_TABLE, [this.serializeCred(cred)]);
    return this.toPublicCred(cred);
  }

  /** Liste les credentials VoIP (masqués) d'un workspace. */
  async listCredentials(workspaceId: string): Promise<PublicVoipCredential[]> {
    const rows = await this.clickhouse.querySystem<CredRow>(
      `SELECT * FROM ${CREDS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      { workspace_id: workspaceId },
    );
    return rows.map((row) => this.toPublicCred(this.parseCred(row)));
  }

  /** Teste un credential contre l'API du provider + persiste le statut. */
  async testCredential(
    workspaceId: string,
    kind: VoipCredentialKind,
  ): Promise<ConnectionTestResult & { status: VoipCredentialStatus }> {
    const cred = await this.findCredential(workspaceId, kind);
    if (!cred) {
      throw new NotFoundException({
        code: 'CREDENTIAL_NOT_FOUND',
        message: `Aucun credential ${kind} pour ce workspace.`,
      });
    }
    const provider = getProvider(kind);
    const creds = provider.parse(
      JSON.parse(this.crypto.decryptCreds(cred.creds_encrypted, workspaceId)),
    );
    const result = await provider.testConnection(creds);
    const status: VoipCredentialStatus = result.ok ? 'ok' : 'failed';
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem(CREDS_TABLE, [
      this.serializeCred({
        ...cred,
        status,
        last_tested_at: now,
        last_error: result.ok ? '' : result.message,
        updated_at: now,
      }),
    ]);
    return { ...result, status };
  }

  /** Soft-delete un credential. */
  async deleteCredential(
    workspaceId: string,
    kind: VoipCredentialKind,
  ): Promise<{ ok: true; deleted: boolean }> {
    const cred = await this.findCredential(workspaceId, kind);
    if (!cred) return { ok: true, deleted: false };
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem(CREDS_TABLE, [
      this.serializeCred({ ...cred, deleted_at: now, updated_at: now }),
    ]);
    return { ok: true, deleted: true };
  }

  /** Lookup interne d'un credential (clear-text non déchiffré ici). */
  async findCredential(
    workspaceId: string,
    kind: VoipCredentialKind,
  ): Promise<VoipCredential | null> {
    const rows = await this.clickhouse.querySystem<CredRow>(
      `SELECT * FROM ${CREDS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND kind = {kind:String}
         AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: workspaceId, kind },
    );
    return rows.length > 0 ? this.parseCred(rows[0]) : null;
  }

  /**
   * Tous les credentials actifs, tous workspaces — utilisé par le sync cron.
   * Renvoie les creds en clair (déchiffrés) prêts à pull. À NE PAS exposer.
   */
  async findAllActiveCredentials(): Promise<
    Array<{ workspaceId: string; kind: VoipCredentialKind; creds: ClearCreds }>
  > {
    const rows = await this.clickhouse.querySystem<CredRow>(
      `SELECT * FROM ${CREDS_TABLE} FINAL
       WHERE deleted_at IS NULL`,
    );
    const out: Array<{
      workspaceId: string;
      kind: VoipCredentialKind;
      creds: ClearCreds;
    }> = [];
    for (const row of rows) {
      const cred = this.parseCred(row);
      try {
        const provider = getProvider(cred.kind);
        const creds = provider.parse(
          JSON.parse(
            this.crypto.decryptCreds(cred.creds_encrypted, cred.workspace_id),
          ),
        );
        out.push({
          workspaceId: cred.workspace_id,
          kind: cred.kind,
          creds,
        });
      } catch (err) {
        this.logger.error(
          `Skipping unreadable VoIP credential ${cred.id} (ws=${cred.workspace_id}): ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  /** Marque la dernière synchro réussie d'un credential. */
  async markSynced(workspaceId: string, kind: VoipCredentialKind): Promise<void> {
    const cred = await this.findCredential(workspaceId, kind);
    if (!cred) return;
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem(CREDS_TABLE, [
      this.serializeCred({
        ...cred,
        last_sync_at: now,
        last_error: '',
        updated_at: now,
      }),
    ]);
  }

  /** Marque une erreur de synchro sur un credential. */
  async markSyncError(
    workspaceId: string,
    kind: VoipCredentialKind,
    error: string,
  ): Promise<void> {
    const cred = await this.findCredential(workspaceId, kind);
    if (!cred) return;
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem(CREDS_TABLE, [
      this.serializeCred({
        ...cred,
        status: 'failed',
        last_error: error.slice(0, 500),
        updated_at: now,
      }),
    ]);
  }

  // ─── Tracked phone numbers (1 numéro = 1 source) ──────────────────

  /** Liste les numéros trackés d'un workspace + les sources autorisées. */
  async listPhoneNumbers(workspaceId: string): Promise<{
    phoneNumbers: PublicPhoneNumber[];
    allowedSources: PhoneSource[];
  }> {
    const rows = await this.clickhouse.querySystem<NumberRow>(
      `SELECT * FROM ${NUMBERS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      { workspace_id: workspaceId },
    );
    return {
      phoneNumbers: rows.map((row) => this.toPublicNumber(this.parseNumber(row))),
      allowedSources: [...PHONE_NUMBER_SOURCES],
    };
  }

  /** Crée un numéro tracké. Normalise en E.164, unicité (workspace, e164). */
  async createPhoneNumber(
    workspaceId: string,
    e164Raw: string,
    source: PhoneSource,
    label: string | null,
  ): Promise<PublicPhoneNumber> {
    const e164 = toE164(e164Raw);
    if (!e164) {
      throw new BadRequestException({ code: 'invalid_e164' });
    }
    const existing = await this.findNumberByE164(workspaceId, e164);
    if (existing) {
      throw new ConflictException({ code: 'already_exists' });
    }
    const now = toClickHouseDateTime();
    const entity: PhoneNumberEntity = {
      id: `phn_${generateId().replace(/-/g, '').slice(0, 22)}`,
      workspace_id: workspaceId,
      e164,
      source,
      label: label ?? '',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await this.clickhouse.insertSystem(NUMBERS_TABLE, [
      this.serializeNumber(entity),
    ]);
    return this.toPublicNumber(entity);
  }

  /** Modifie la source / le label d'un numéro (pas le numéro lui-même). */
  async updatePhoneNumber(
    workspaceId: string,
    id: string,
    patch: { source?: PhoneSource; label?: string | null },
  ): Promise<PublicPhoneNumber> {
    const existing = await this.findNumberById(workspaceId, id);
    if (!existing) {
      throw new NotFoundException({ code: 'NUMBER_NOT_FOUND' });
    }
    const now = toClickHouseDateTime();
    const updated: PhoneNumberEntity = {
      ...existing,
      source: patch.source ?? existing.source,
      label: patch.label !== undefined ? (patch.label ?? '') : existing.label,
      updated_at: now,
    };
    await this.clickhouse.insertSystem(NUMBERS_TABLE, [
      this.serializeNumber(updated),
    ]);
    return this.toPublicNumber(updated);
  }

  /** Soft-delete un numéro tracké. */
  async deletePhoneNumber(
    workspaceId: string,
    id: string,
  ): Promise<{ ok: true; deleted: boolean }> {
    const existing = await this.findNumberById(workspaceId, id);
    if (!existing) return { ok: true, deleted: false };
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem(NUMBERS_TABLE, [
      this.serializeNumber({ ...existing, deleted_at: now, updated_at: now }),
    ]);
    return { ok: true, deleted: true };
  }

  /**
   * Construit la table de lookup (e164 → source) d'un workspace, pour que le
   * sync attribue chaque appel à sa source de trafic. Numéro inconnu → le
   * sync retombe sur `direct` (default safe).
   */
  async buildSourceLookup(
    workspaceId: string,
  ): Promise<Map<string, { source: PhoneSource; id: string; label: string }>> {
    const { phoneNumbers } = await this.listPhoneNumbers(workspaceId);
    const map = new Map<
      string,
      { source: PhoneSource; id: string; label: string }
    >();
    for (const n of phoneNumbers) {
      map.set(n.e164, {
        source: n.source,
        id: n.id,
        label: n.label ?? '',
      });
    }
    return map;
  }

  private async findNumberById(
    workspaceId: string,
    id: string,
  ): Promise<PhoneNumberEntity | null> {
    const rows = await this.clickhouse.querySystem<NumberRow>(
      `SELECT * FROM ${NUMBERS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND id = {id:String}
         AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: workspaceId, id },
    );
    return rows.length > 0 ? this.parseNumber(rows[0]) : null;
  }

  private async findNumberByE164(
    workspaceId: string,
    e164: string,
  ): Promise<PhoneNumberEntity | null> {
    const rows = await this.clickhouse.querySystem<NumberRow>(
      `SELECT * FROM ${NUMBERS_TABLE} FINAL
       WHERE workspace_id = {workspace_id:String}
         AND e164 = {e164:String}
         AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: workspaceId, e164 },
    );
    return rows.length > 0 ? this.parseNumber(rows[0]) : null;
  }

  // ─── (de)serialization ────────────────────────────────────────────

  private serializeCred(c: VoipCredential): Record<string, unknown> {
    return {
      id: c.id,
      workspace_id: c.workspace_id,
      kind: c.kind,
      creds_encrypted: c.creds_encrypted,
      status: c.status,
      last_sync_at: c.last_sync_at,
      last_tested_at: c.last_tested_at,
      last_error: c.last_error,
      created_at: c.created_at,
      updated_at: c.updated_at,
      deleted_at: c.deleted_at,
    };
  }

  private parseCred(row: CredRow): VoipCredential {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      kind: row.kind as VoipCredentialKind,
      creds_encrypted: row.creds_encrypted ?? '',
      status: (row.status as VoipCredentialStatus) ?? 'untested',
      last_sync_at: row.last_sync_at,
      last_tested_at: row.last_tested_at,
      last_error: row.last_error ?? '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }

  private toPublicCred(c: VoipCredential): PublicVoipCredential {
    const provider = VOIP_CREDENTIAL_KINDS.includes(c.kind)
      ? getProvider(c.kind)
      : null;
    let masked: Record<string, string> = {};
    if (provider && c.creds_encrypted) {
      try {
        const clear = provider.parse(
          JSON.parse(
            this.crypto.decryptCreds(c.creds_encrypted, c.workspace_id),
          ),
        );
        masked = provider.mask(clear);
      } catch (err) {
        this.logger.warn(
          `Cannot mask creds for ${c.id}: ${(err as Error).message}`,
        );
      }
    }
    return {
      kind: c.kind,
      label: provider?.label ?? c.kind,
      status: c.status,
      masked,
      lastSyncAt: c.last_sync_at,
      lastTestedAt: c.last_tested_at,
      lastError: c.last_error || null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  }

  private serializeNumber(n: PhoneNumberEntity): Record<string, unknown> {
    return {
      id: n.id,
      workspace_id: n.workspace_id,
      e164: n.e164,
      source: n.source,
      label: n.label,
      created_at: n.created_at,
      updated_at: n.updated_at,
      deleted_at: n.deleted_at,
    };
  }

  private parseNumber(row: NumberRow): PhoneNumberEntity {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      e164: row.e164,
      source: isPhoneSource(row.source) ? row.source : 'direct',
      label: row.label ?? '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }

  private toPublicNumber(n: PhoneNumberEntity): PublicPhoneNumber {
    return {
      id: n.id,
      e164: n.e164,
      source: n.source,
      label: n.label || null,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    };
  }

  /** Exposé pour le mapping kind→provider côté sync. */
  providerOf(kind: VoipCredentialKind): 'ovh' | 'telnyx' {
    return kindToProvider(kind);
  }
}
