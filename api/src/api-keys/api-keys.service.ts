import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { MembersService } from '../members/members.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { ListApiKeysDto } from './dto/list-api-keys.dto';
import { RevokeApiKeyDto } from './dto/revoke-api-key.dto';
import { CreateApiKeyResponseDto } from './dto/create-api-key-response.dto';
import {
  ApiKey,
  PublicApiKey,
  ApiKeyRole,
  ApiKeyStatus,
} from '../common/entities/api-key.entity';
import { generateId, generateApiKeyToken, hashToken } from '../common/crypto';
import { hasPermission, ROLE_HIERARCHY } from '../common/permissions';
import {
  toClickHouseDateTime,
  isoToClickHouseDateTime,
  parseClickHouseDateTime,
} from '../common/utils/datetime.util';

interface ApiKeyRow extends Omit<ApiKey, 'role'> {
  role: string; // Enum string from ClickHouse
}

function parseApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description,
    role: row.role as ApiKeyRole,
    status: row.status,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    failed_attempts_count: row.failed_attempts_count,
    last_failed_attempt_at: row.last_failed_attempt_at,
    created_by: row.created_by,
    revoked_by: row.revoked_by,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeApiKey(apiKey: ApiKey): ApiKeyRow {
  return {
    id: apiKey.id,
    key_hash: apiKey.key_hash,
    key_prefix: apiKey.key_prefix,
    user_id: apiKey.user_id,
    workspace_id: apiKey.workspace_id,
    name: apiKey.name,
    description: apiKey.description,
    role: apiKey.role,
    status: apiKey.status,
    expires_at: isoToClickHouseDateTime(apiKey.expires_at),
    last_used_at: apiKey.last_used_at,
    failed_attempts_count: apiKey.failed_attempts_count,
    last_failed_attempt_at: apiKey.last_failed_attempt_at,
    created_by: apiKey.created_by,
    revoked_by: apiKey.revoked_by,
    revoked_at: apiKey.revoked_at,
    created_at: apiKey.created_at,
    updated_at: apiKey.updated_at,
  };
}

function toPublicApiKey(apiKey: ApiKey): PublicApiKey {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { key_hash, ...publicKey } = apiKey;
  return publicKey;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    @Inject(forwardRef(() => MembersService))
    private readonly membersService: MembersService,
  ) {}

  async create(
    dto: CreateApiKeyDto & { user_id: string },
    created_by: string,
  ): Promise<CreateApiKeyResponseDto> {
    // Validate role before creating
    await this.validateRoleForUser(dto.workspace_id, created_by, dto.role);

    const now = toClickHouseDateTime();
    const { key, hash, prefix } = generateApiKeyToken();

    const apiKey: ApiKey = {
      id: generateId(),
      key_hash: hash,
      key_prefix: prefix,
      user_id: dto.user_id,
      workspace_id: dto.workspace_id ?? null,
      name: dto.name,
      description: dto.description ?? '',
      role: dto.role,
      status: 'active',
      expires_at: dto.expires_at ?? null,
      last_used_at: null,
      failed_attempts_count: 0,
      last_failed_attempt_at: null,
      created_by,
      revoked_by: null,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };

    await this.clickhouse.insertSystem('api_keys', [serializeApiKey(apiKey)]);

    return {
      key,
      apiKey: toPublicApiKey(apiKey),
    };
  }

  /**
   * Create a workspace-scoped API key for a PLATFORM-MANAGED workspace (M2M).
   *
   * Unlike create(), this does NOT call validateRoleForUser: it is only ever
   * reached behind PlatformAdminGuard (the shared platform secret = the highest
   * authority). A platform-managed workspace has NO members, so requiring a
   * membership would be an impossible egg-and-chicken (task #8). The caller
   * (admin-platform) is responsible for asserting the workspace exists first.
   *
   * user_id / created_by are the synthetic 'platform' principal so the key's
   * origin is auditable (it is not tied to a real user).
   */
  async createForPlatform(params: {
    workspace_id: string;
    name?: string;
    role?: ApiKeyRole;
    description?: string;
  }): Promise<CreateApiKeyResponseDto> {
    const now = toClickHouseDateTime();
    const { key, hash, prefix } = generateApiKeyToken();
    const apiKey: ApiKey = {
      id: generateId(),
      key_hash: hash,
      key_prefix: prefix,
      user_id: 'platform',
      workspace_id: params.workspace_id,
      name: params.name ?? 'Platform-provisioned key',
      description:
        params.description ??
        'Auto-provisioned via /api/admin/platform/workspaces.provisionApiKey (M2M).',
      role: params.role ?? 'admin',
      status: 'active',
      expires_at: null,
      last_used_at: null,
      failed_attempts_count: 0,
      last_failed_attempt_at: null,
      created_by: 'platform-admin',
      revoked_by: null,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.clickhouse.insertSystem('api_keys', [serializeApiKey(apiKey)]);
    return { key, apiKey: toPublicApiKey(apiKey) };
  }

  /**
   * Revoke a workspace-scoped API key on behalf of the PLATFORM (M2M).
   *
   * The symmetric of createForPlatform: it is only ever reached behind
   * PlatformAdminGuard, so there is NO membership / JWT check (a
   * platform-managed workspace has no members — cf createForPlatform).
   *
   * The key is resolved by `id` OR by `key_prefix` (the prefix is the only
   * stable handle the caller keeps — provisionApiKey returns `key_prefix`,
   * never the internal `id`). In BOTH cases the resolved key MUST belong to
   * the given workspace: a mismatch throws NotFound rather than silently
   * revoking another workspace's key. This makes the operation auditable and
   * prevents cross-workspace revocation by id-guessing even with the
   * platform secret.
   *
   * Idempotent on an already-revoked key: re-revoking returns the existing
   * revoked key unchanged (no error) so retries are safe.
   */
  async revokeForPlatform(params: {
    workspace_id: string;
    key_id?: string;
    key_prefix?: string;
  }): Promise<PublicApiKey> {
    if (!params.key_id && !params.key_prefix) {
      throw new BadRequestException(
        'Either key_id or key_prefix must be provided to revoke a key.',
      );
    }

    const apiKey = await this.resolveWorkspaceKey(params);

    // Idempotent: a key already revoked is returned as-is.
    if (apiKey.status === 'revoked') {
      return toPublicApiKey(apiKey);
    }

    const now = toClickHouseDateTime();
    const updated: ApiKey = {
      ...apiKey,
      status: 'revoked',
      revoked_by: 'platform-admin',
      revoked_at: now,
      updated_at: now,
    };

    // Delete + re-insert (ClickHouse pattern, mirrors revoke()). `id` is a
    // system-generated value (never raw caller input) so the literal
    // interpolation is safe here.
    await this.clickhouse.commandSystem(
      `ALTER TABLE api_keys DELETE WHERE id = '${apiKey.id}'`,
    );
    await this.clickhouse.insertSystem('api_keys', [serializeApiKey(updated)]);

    return toPublicApiKey(updated);
  }

  /**
   * List the API keys of a workspace on behalf of the PLATFORM (M2M).
   *
   * Thin wrapper over list() pinned to a workspace, exposed for audit
   * behind PlatformAdminGuard (the JWT-only apiKeys.list cannot be reached
   * by a memberless platform-managed workspace).
   */
  async listForPlatform(
    workspaceId: string,
    status?: ApiKeyStatus,
  ): Promise<PublicApiKey[]> {
    return this.list({ workspace_id: workspaceId, status });
  }

  /**
   * Resolve a single API key by (workspace_id + id) or (workspace_id +
   * key_prefix), enforcing workspace ownership. Throws NotFound if the key
   * does not exist or belongs to another workspace.
   */
  private async resolveWorkspaceKey(params: {
    workspace_id: string;
    key_id?: string;
    key_prefix?: string;
  }): Promise<ApiKey> {
    const whereClauses = ['workspace_id = {workspace_id:String}'];
    const queryParams: Record<string, unknown> = {
      workspace_id: params.workspace_id,
    };
    if (params.key_id) {
      whereClauses.push('id = {id:String}');
      queryParams.id = params.key_id;
    }
    if (params.key_prefix) {
      whereClauses.push('key_prefix = {key_prefix:String}');
      queryParams.key_prefix = params.key_prefix;
    }

    const dedupCondition = `(id, updated_at) IN (
      SELECT id, max(updated_at) FROM api_keys GROUP BY id
    )`;

    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      `SELECT * FROM api_keys
       WHERE ${whereClauses.join(' AND ')} AND ${dedupCondition}
       ORDER BY created_at DESC`,
      queryParams,
    );

    if (rows.length === 0) {
      throw new NotFoundException(
        params.key_id
          ? `API key ${params.key_id} not found in workspace ${params.workspace_id}`
          : `API key with prefix ${params.key_prefix} not found in workspace ${params.workspace_id}`,
      );
    }
    if (rows.length > 1) {
      // key_prefix is not guaranteed unique; refuse to guess which to revoke.
      throw new ConflictException(
        `Multiple API keys match prefix ${params.key_prefix} in workspace ${params.workspace_id}; revoke by key_id instead.`,
      );
    }

    return parseApiKey(rows[0]);
  }

  async list(dto: ListApiKeysDto = {}): Promise<PublicApiKey[]> {
    const whereClauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (dto.user_id) {
      whereClauses.push('user_id = {user_id:String}');
      params.user_id = dto.user_id;
    }

    if (dto.workspace_id !== undefined) {
      if (dto.workspace_id === null) {
        whereClauses.push('workspace_id IS NULL');
      } else {
        whereClauses.push('workspace_id = {workspace_id:String}');
        params.workspace_id = dto.workspace_id;
      }
    }

    if (dto.status) {
      whereClauses.push('status = {status:String}');
      params.status = dto.status;
    }

    // Build WHERE clause - always include the deduplication condition
    const dedupCondition = `(id, updated_at) IN (
      SELECT id, max(updated_at) FROM api_keys GROUP BY id
    )`;

    let whereClause: string;
    if (whereClauses.length > 0) {
      whereClause = `WHERE ${whereClauses.join(' AND ')} AND ${dedupCondition}`;
    } else {
      whereClause = `WHERE ${dedupCondition}`;
    }

    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      `SELECT * FROM api_keys
       ${whereClause}
       ORDER BY created_at DESC`,
      params,
    );

    return rows.map((row) => toPublicApiKey(parseApiKey(row)));
  }

  async get(id: string): Promise<PublicApiKey> {
    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = {id:String} ORDER BY updated_at DESC LIMIT 1',
      { id },
    );

    if (rows.length === 0) {
      throw new NotFoundException(`API key ${id} not found`);
    }

    return toPublicApiKey(parseApiKey(rows[0]));
  }

  async revoke(dto: RevokeApiKeyDto): Promise<PublicApiKey> {
    // Verify the key exists first (will throw NotFoundException if not)
    await this.get(dto.id);

    // Get the full API key from database to perform update
    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = {id:String} ORDER BY updated_at DESC LIMIT 1',
      { id: dto.id },
    );

    if (rows.length === 0) {
      throw new NotFoundException(`API key ${dto.id} not found`);
    }

    const fullApiKey = parseApiKey(rows[0]);
    const now = toClickHouseDateTime();

    const updated: ApiKey = {
      ...fullApiKey,
      status: 'revoked',
      revoked_by: dto.revoked_by,
      revoked_at: now,
      updated_at: now,
    };

    // Delete and re-insert (ClickHouse pattern)
    await this.clickhouse.commandSystem(
      `ALTER TABLE api_keys DELETE WHERE id = '${dto.id}'`,
    );
    await this.clickhouse.insertSystem('api_keys', [serializeApiKey(updated)]);

    return toPublicApiKey(updated);
  }

  /**
   * Check if API key is expired based on expires_at timestamp
   */
  private isExpired(apiKey: ApiKey): boolean {
    if (!apiKey.expires_at) {
      return false;
    }
    const expiresAt = parseClickHouseDateTime(apiKey.expires_at);
    return expiresAt < new Date();
  }

  /**
   * Update API key status to expired if expires_at has passed
   * This can be called periodically or when fetching keys
   */
  async updateExpiredStatus(id: string): Promise<void> {
    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = {id:String} ORDER BY updated_at DESC LIMIT 1',
      { id },
    );

    if (rows.length === 0) {
      return;
    }

    const apiKey = parseApiKey(rows[0]);

    if (apiKey.status === 'active' && this.isExpired(apiKey)) {
      const now = toClickHouseDateTime();
      const updated: ApiKey = {
        ...apiKey,
        status: 'expired',
        updated_at: now,
      };

      await this.clickhouse.commandSystem(
        `ALTER TABLE api_keys DELETE WHERE id = '${id}'`,
      );
      await this.clickhouse.insertSystem('api_keys', [
        serializeApiKey(updated),
      ]);
    }
  }

  /**
   * Find API key by raw token (for authentication).
   * Hashes the token and looks up by key_hash.
   */
  async findByToken(token: string): Promise<ApiKey | null> {
    const hash = hashToken(token);

    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      `SELECT * FROM api_keys
       WHERE key_hash = {hash:String}
       ORDER BY updated_at DESC
       LIMIT 1`,
      { hash },
    );

    if (rows.length === 0) {
      return null;
    }

    return parseApiKey(rows[0]);
  }

  /**
   * Update last_used_at timestamp (fire-and-forget).
   */
  async updateLastUsed(id: string): Promise<void> {
    const now = toClickHouseDateTime();

    const rows = await this.clickhouse.querySystem<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = {id:String} ORDER BY updated_at DESC LIMIT 1',
      { id },
    );

    if (rows.length === 0) {
      return;
    }

    const apiKey = parseApiKey(rows[0]);
    const updated: ApiKey = {
      ...apiKey,
      last_used_at: now,
      updated_at: now,
    };

    await this.clickhouse.insertSystem('api_keys', [serializeApiKey(updated)]);
  }

  /**
   * Validate that the user can create an API key with the requested role.
   * Users can only create API keys with roles at or below their own role level.
   */
  async validateRoleForUser(
    workspaceId: string,
    userId: string,
    requestedRole: ApiKeyRole,
  ): Promise<void> {
    const membership = await this.membersService.getMembership(
      workspaceId,
      userId,
    );

    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    // Check integrations.manage permission (required to create API keys)
    if (!hasPermission(membership.role, 'integrations.manage')) {
      throw new ForbiddenException(
        'Insufficient permissions to create API keys',
      );
    }

    // Users can only create API keys with roles at or below their own role level
    if (ROLE_HIERARCHY[requestedRole] > ROLE_HIERARCHY[membership.role]) {
      throw new ForbiddenException(
        `Cannot create API key with role '${requestedRole}': exceeds your role level`,
      );
    }
  }
}
