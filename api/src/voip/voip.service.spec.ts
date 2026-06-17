import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { VoipCrypto } from './voip-crypto.service';
import { VoipService } from './voip.service';

/**
 * Mock in-memory ClickHouse — comprend le sous-ensemble de SQL émis par
 * VoipService (filtrage workspace_id / kind / id / e164 / deleted_at) +
 * sémantique FINAL du ReplacingMergeTree (dernière version par id).
 */
function makeClickhouseMock(): jest.Mocked<ClickHouseService> {
  const tables = new Map<string, Record<string, unknown>[]>();

  function filter(
    rows: Record<string, unknown>[],
    sql: string,
    params: Record<string, unknown>,
  ) {
    return rows.filter((row) => {
      if (/deleted_at IS NULL/.test(sql) && row.deleted_at) return false;
      if (
        sql.includes('workspace_id = {workspace_id:String}') &&
        row.workspace_id !== params.workspace_id
      )
        return false;
      if (sql.includes('kind = {kind:String}') && row.kind !== params.kind)
        return false;
      if (sql.includes('id = {id:String}') && row.id !== params.id)
        return false;
      if (sql.includes('e164 = {e164:String}') && row.e164 !== params.e164)
        return false;
      return true;
    });
  }

  return {
    querySystem: jest.fn(
      async (sql: string, params: Record<string, unknown> = {}) => {
        const match = sql.match(/FROM\s+(\w+)/i);
        if (!match) return [];
        const rows = tables.get(match[1]) ?? [];
        const filtered = filter(rows, sql, params);
        const byId = new Map<string, Record<string, unknown>>();
        for (const r of filtered) {
          const id = r.id as string;
          const cur = byId.get(id);
          if (!cur || (r.updated_at as string) >= (cur.updated_at as string)) {
            byId.set(id, r);
          }
        }
        return Array.from(byId.values());
      },
    ),
    insertSystem: jest.fn(async (table: string, values: unknown[]) => {
      const arr = tables.get(table) ?? [];
      arr.push(...(values as Record<string, unknown>[]));
      tables.set(table, arr);
    }),
  } as unknown as jest.Mocked<ClickHouseService>;
}

function makeService(): { svc: VoipService; ch: jest.Mocked<ClickHouseService> } {
  const ch = makeClickhouseMock();
  const config = {
    get: (key: string) =>
      key === 'ENCRYPTION_KEY'
        ? 'x'.repeat(64) // 64-char hex-ish master key for tests
        : undefined,
  } as unknown as ConfigService;
  const crypto = new VoipCrypto(config);
  return { svc: new VoipService(ch, crypto), ch };
}

describe('VoipService — credentials', () => {
  it('saves a Telnyx credential, never persists clear-text', async () => {
    const { svc, ch } = makeService();
    const pub = await svc.saveCredential('ws_1', 'voip_telnyx', {
      apiKey: 'KEY0123456789abcdef',
    });
    expect(pub.kind).toBe('voip_telnyx');
    expect(pub.status).toBe('untested');
    // masked, never the real key
    expect(pub.masked.apiKey).toBe('••••cdef');

    const insert = ch.insertSystem.mock.calls[0][1][0] as Record<string, unknown>;
    expect(String(insert.creds_encrypted)).not.toContain('KEY0123456789abcdef');
    expect(String(insert.creds_encrypted)).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('rejects invalid creds with a 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.saveCredential('ws_1', 'voip_telnyx', { apiKey: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('round-trips: list returns the saved (masked) credential', async () => {
    const { svc } = makeService();
    await svc.saveCredential('ws_1', 'voip_ovh', {
      applicationKey: 'app-key-value',
      applicationSecret: 'app-secret-value',
      consumerKey: 'consumer-key-value',
    });
    const list = await svc.listCredentials('ws_1');
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('OVH Telephony');
    expect(list[0].masked.applicationKey).toBe('••••alue');
    expect(list[0].masked.endpoint).toBe('ovh-eu');
  });

  it('isolates credentials per workspace', async () => {
    const { svc } = makeService();
    await svc.saveCredential('ws_1', 'voip_telnyx', { apiKey: 'KEYaaaabbbbcccc' });
    expect(await svc.listCredentials('ws_2')).toHaveLength(0);
  });

  it('soft-deletes a credential', async () => {
    const { svc } = makeService();
    await svc.saveCredential('ws_1', 'voip_telnyx', { apiKey: 'KEYaaaabbbbcccc' });
    const res = await svc.deleteCredential('ws_1', 'voip_telnyx');
    expect(res.deleted).toBe(true);
    expect(await svc.listCredentials('ws_1')).toHaveLength(0);
  });

  it('test on missing credential throws NotFound', async () => {
    const { svc } = makeService();
    await expect(svc.testCredential('ws_1', 'voip_ovh')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('VoipService — phone numbers', () => {
  it('creates a tracked number normalized to E.164', async () => {
    const { svc } = makeService();
    const n = await svc.createPhoneNumber('ws_1', '01 77 12 34 56', 'seo', 'Ligne SEO');
    expect(n.e164).toBe('+33177123456');
    expect(n.source).toBe('seo');
    expect(n.label).toBe('Ligne SEO');
  });

  it('rejects an unparseable number (invalid_e164)', async () => {
    const { svc } = makeService();
    await expect(
      svc.createPhoneNumber('ws_1', 'not-a-number', 'seo', null),
    ).rejects.toMatchObject({ response: { code: 'invalid_e164' } });
  });

  it('rejects a duplicate number (already_exists)', async () => {
    const { svc } = makeService();
    await svc.createPhoneNumber('ws_1', '+33177123456', 'seo', null);
    await expect(
      svc.createPhoneNumber('ws_1', '0177123456', 'ads', null),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates source/label of a number', async () => {
    const { svc } = makeService();
    const n = await svc.createPhoneNumber('ws_1', '+33177123456', 'seo', null);
    const up = await svc.updatePhoneNumber('ws_1', n.id, {
      source: 'ads',
      label: 'Campagne Ads',
    });
    expect(up.source).toBe('ads');
    expect(up.label).toBe('Campagne Ads');
  });

  it('builds a (e164 → source) lookup for the sync', async () => {
    const { svc } = makeService();
    await svc.createPhoneNumber('ws_1', '+33177123456', 'seo', 'SEO');
    await svc.createPhoneNumber('ws_1', '+33180654321', 'ads', 'Ads');
    const lookup = await svc.buildSourceLookup('ws_1');
    expect(lookup.get('+33177123456')?.source).toBe('seo');
    expect(lookup.get('+33180654321')?.source).toBe('ads');
    expect(lookup.get('+33199999999')).toBeUndefined();
  });

  it('exposes the 7 allowed sources', async () => {
    const { svc } = makeService();
    const { allowedSources } = await svc.listPhoneNumbers('ws_1');
    expect(allowedSources).toEqual([
      'seo',
      'ads',
      'direct',
      'email',
      'social',
      'print',
      'other',
    ]);
  });
});
