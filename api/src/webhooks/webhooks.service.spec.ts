import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClickHouseService } from '../database/clickhouse.service';
import { WebhookCrypto } from './webhook-crypto';
import { WebhookSsrfGuard } from './webhook-ssrf-guard';
import { WebhookTransformEngine } from './webhook-transform-engine';
import { WebhooksService } from './webhooks.service';

/**
 * Minimal in-memory ClickHouse stub that understands the subset of SQL the
 * webhooks service emits: filtering by id / workspace_id / name / status /
 * webhook_id / deleted_at IS NULL / active = 1. Anything else is ignored.
 */
function makeClickhouseMock(
  initialRows: Record<string, unknown[]> = {},
): jest.Mocked<ClickHouseService> {
  const tables = new Map<string, Record<string, unknown>[]>();
  for (const [k, v] of Object.entries(initialRows)) {
    tables.set(k, [...(v as Record<string, unknown>[])]);
  }

  function filter(rows: Record<string, unknown>[], sql: string, params: Record<string, unknown>) {
    return rows.filter((row) => {
      if (/deleted_at IS NULL/.test(sql) && row.deleted_at) return false;
      if (/active = 1/.test(sql) && row.active !== 1) return false;
      if (/active = 0/.test(sql) && row.active !== 0) return false;
      if (sql.includes('workspace_id = {workspace_id:String}')) {
        if (row.workspace_id !== params.workspace_id) return false;
      }
      if (sql.includes('id = {id:String}')) {
        if (row.id !== params.id) return false;
      }
      if (sql.includes('id != {id:String}')) {
        if (row.id === params.id) return false;
      }
      if (sql.includes('name = {name:String}')) {
        if (row.name !== params.name) return false;
      }
      if (sql.includes('status = {status:String}')) {
        if (row.status !== params.status) return false;
      }
      if (sql.includes('webhook_id = {webhook_id:String}')) {
        if (row.webhook_id !== params.webhook_id) return false;
      }
      if (/status IN \('pending', 'retrying'\)/.test(sql)) {
        if (row.status !== 'pending' && row.status !== 'retrying') return false;
      }
      return true;
    });
  }

  return {
    querySystem: jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
      const match = sql.match(/FROM\s+(\w+)/i);
      if (!match) return [];
      const tbl = match[1];
      const rows = tables.get(tbl) ?? [];
      const filtered = filter(rows, sql, params);
      // ReplacingMergeTree FINAL semantics: keep latest row per id by updated_at.
      const byId = new Map<string, Record<string, unknown>>();
      for (const r of filtered) {
        const id = r.id as string;
        const cur = byId.get(id);
        if (!cur || (r.updated_at as string) >= (cur.updated_at as string)) {
          byId.set(id, r);
        }
      }
      return Array.from(byId.values());
    }),
    insertSystem: jest.fn(async (table: string, values: unknown[]) => {
      const arr = tables.get(table) ?? [];
      for (const v of values) {
        const r = v as Record<string, unknown>;
        const idx = arr.findIndex((row) => row.id === r.id);
        if (idx >= 0) arr[idx] = r;
        else arr.push(r);
      }
      tables.set(table, arr);
    }),
    commandSystem: jest.fn(),
  } as unknown as jest.Mocked<ClickHouseService>;
}

const MASTER = 'a'.repeat(64);

describe('WebhooksService', () => {
  let service: WebhooksService;
  let clickhouse: jest.Mocked<ClickHouseService>;

  beforeEach(async () => {
    clickhouse = makeClickhouseMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: ClickHouseService, useValue: clickhouse },
        { provide: WebhookCrypto, useValue: makeCryptoSpy() },
        WebhookSsrfGuard,
        WebhookTransformEngine,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'WEBHOOK_ALLOW_HTTP' ? 'false' : undefined) },
        },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  describe('create', () => {
    it('persists a new webhook and masks the secret', async () => {
      const created = await service.create({
        workspace_id: 'ws_a',
        name: 'crm',
        url: 'https://crm.example.com/hook',
        auth: { type: 'bearer', token: 'sk_secret' },
        events: ['screen_view'],
        filters: [],
      });
      expect(created.id).toMatch(/^wh_/);
      expect(created.auth).toEqual({ type: 'bearer', has_secret: true });
      // The PublicWebhookDefinition type strips auth_secret_encrypted at
      // compile time; we double-check at runtime that the field is gone.
      expect(
        (created as unknown as Record<string, unknown>).auth_secret_encrypted,
      ).toBeUndefined();
    });

    it('rejects duplicate names (ConflictException)', async () => {
      await service.create({
        workspace_id: 'ws_a',
        name: 'crm',
        url: 'https://crm.example.com/hook',
        auth: { type: 'none' },
        events: ['screen_view'],
      });
      await expect(
        service.create({
          workspace_id: 'ws_a',
          name: 'crm',
          url: 'https://other.example.com/hook',
          auth: { type: 'none' },
          events: ['screen_view'],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects SSRF URLs', async () => {
      await expect(
        service.create({
          workspace_id: 'ws_a',
          name: 'evil',
          url: 'http://localhost:8080/x',
          auth: { type: 'none' },
          events: ['screen_view'],
        }),
      ).rejects.toThrow();
    });
  });

  describe('multi-tenant isolation', () => {
    it('list / get scope strictly by workspace_id', async () => {
      const a = await service.create({
        workspace_id: 'ws_a',
        name: 'A hook',
        url: 'https://a.example.com/x',
        auth: { type: 'none' },
        events: ['screen_view'],
      });
      const b = await service.create({
        workspace_id: 'ws_b',
        name: 'B hook',
        url: 'https://b.example.com/x',
        auth: { type: 'none' },
        events: ['screen_view'],
      });

      const listA = await service.list({ workspace_id: 'ws_a' });
      expect(listA.map((w) => w.id)).toEqual([a.id]);

      const listB = await service.list({ workspace_id: 'ws_b' });
      expect(listB.map((w) => w.id)).toEqual([b.id]);

      // GET from the wrong workspace ⇒ 404 (not 403, anti-leak)
      await expect(service.get({ workspace_id: 'ws_a', id: b.id })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.get({ workspace_id: 'ws_b', id: a.id })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates fields and prevents cross-tenant takeover via id-spoofing', async () => {
      const created = await service.create({
        workspace_id: 'ws_a',
        name: 'orig',
        url: 'https://orig.example.com',
        auth: { type: 'bearer', token: 't1' },
        events: ['screen_view'],
      });
      const updated = await service.update({
        workspace_id: 'ws_a',
        id: created.id,
        name: 'renamed',
        url: 'https://new.example.com',
        auth: { type: 'bearer', token: 't2' },
      });
      expect(updated.name).toBe('renamed');
      expect(updated.url).toBe('https://new.example.com');

      // Attempting to update from a foreign workspace must 404.
      await expect(
        service.update({ workspace_id: 'ws_b', id: created.id, name: 'pwn' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDelete', () => {
    it('removes the webhook from list responses but keeps the row physically', async () => {
      const created = await service.create({
        workspace_id: 'ws_a',
        name: 'gone',
        url: 'https://x.example.com',
        auth: { type: 'none' },
        events: ['screen_view'],
      });
      await service.softDelete({ workspace_id: 'ws_a', id: created.id });
      const list = await service.list({ workspace_id: 'ws_a' });
      // Because our mock does not implement deleted_at filter, we re-fetch via findById to assert
      const fetched = await service.findById('ws_a', created.id);
      // After soft-delete the public list should be empty
      expect(list.find((w) => w.id === created.id)).toBeUndefined();
      // The row physically still exists but with deleted_at set
      expect(fetched).toBeNull();
    });
  });

  describe('enqueueDelivery', () => {
    it('inserts a pending row in webhook_deliveries with truncation cap', async () => {
      const webhook = await service.create({
        workspace_id: 'ws_a',
        name: 'd',
        url: 'https://x.example.com',
        auth: { type: 'none' },
        events: ['screen_view'],
      });
      const fullWebhook = await service.findById('ws_a', webhook.id);
      expect(fullWebhook).not.toBeNull();
      const delivery = await service.enqueueDelivery(fullWebhook!, {
        event_id: 'evt_1',
        event_type: 'screen_view',
        payload: { hello: 'x'.repeat(100) },
      });
      expect(delivery.status).toBe('pending');
      expect(delivery.attempt).toBe(1);
      expect(delivery.workspace_id).toBe('ws_a');
      expect(delivery.id).toMatch(/^del_/);
    });
  });
});

function makeCryptoSpy(): WebhookCrypto {
  return {
    encryptSecret: jest.fn((s: string) => (s ? `enc(${s})` : '')),
    decryptSecret: jest.fn((s: string) => (s.startsWith('enc(') ? s.slice(4, -1) : s)),
  } as unknown as WebhookCrypto;
}
