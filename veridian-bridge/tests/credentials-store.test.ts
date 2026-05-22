/**
 * Tests unitaires — couche DB credentials (U8).
 *
 * Couvre `src/credentials/store.ts` :
 *   - saveCredential : valide, chiffre, upsert (status untested)
 *   - listCredentials : ne renvoie QUE des vues masquées
 *   - testCredential : déchiffre, teste, persiste status/lastError
 *   - deleteCredential : supprime, idempotent
 *   - error paths : tenant inconnu, kind inconnu, creds invalides
 *
 * Tourne sur `FakePrismaClientWithSettings` (in-memory). La preuve du
 * comportement Postgres réel (contrainte @@unique, cascade) est dans
 * `tests/integration/settings/*.integration.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  saveCredential,
  listCredentials,
  testCredential,
  deleteCredential,
  CredentialError,
} from "../src/credentials/store.js";
import { decryptJson, type EncryptedBlob } from "../src/credentials/crypto.js";
import { FakePrismaClientWithSettings } from "./helpers/fake-prisma-settings.js";

const KEY = "c".repeat(64);

function mockFetch(status: number): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => "1700000000",
      json: async () => ({}),
    }) as unknown as Response) as typeof fetch;
}

async function seed(): Promise<{
  prisma: FakePrismaClientWithSettings;
  tenantId: string;
}> {
  const prisma = new FakePrismaClientWithSettings();
  await prisma.tenant.create({
    data: { id: "t1", workspaceId: "ws1", slug: "acme", name: "Acme" },
  });
  return { prisma, tenantId: "t1" };
}

const asPrisma = (p: FakePrismaClientWithSettings) =>
  p as unknown as PrismaClient;

// ─── saveCredential ─────────────────────────────────────────────────────────

test("saveCredential chiffre et upsert des creds Telnyx", async () => {
  const { prisma, tenantId } = await seed();
  const view = await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY01ABCDEF0123456789" },
    KEY,
  );
  assert.equal(view.kind, "voip_telnyx");
  assert.equal(view.status, "untested");
  assert.equal(view.masked.apiKey, "••••6789");

  // En DB : la donnée est chiffrée, pas en clair.
  const row = prisma.tenantCredentials[0];
  assert.ok(row);
  const blob = row.encryptedData as EncryptedBlob;
  assert.equal(blob.v, 1);
  const clear = decryptJson<{ apiKey: string }>(blob, KEY);
  assert.equal(clear.apiKey, "KEY01ABCDEF0123456789");
});

test("saveCredential chiffre des creds OVH (3 clés)", async () => {
  const { prisma, tenantId } = await seed();
  const view = await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_ovh",
    {
      applicationKey: "ovh-application-key",
      applicationSecret: "ovh-application-secret",
      consumerKey: "ovh-consumer-key",
    },
    KEY,
  );
  assert.equal(view.kind, "voip_ovh");
  assert.match(view.masked.applicationSecret, /^••••/);
  const clear = decryptJson<{ applicationSecret: string }>(
    prisma.tenantCredentials[0].encryptedData as EncryptedBlob,
    KEY,
  );
  assert.equal(clear.applicationSecret, "ovh-application-secret");
});

test("saveCredential remplace les creds existantes (upsert, pas de double-row)", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEYoldoldoldold0000" },
    KEY,
  );
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEYnewnewnewnew9999" },
    KEY,
  );
  assert.equal(prisma.tenantCredentials.length, 1);
  const clear = decryptJson<{ apiKey: string }>(
    prisma.tenantCredentials[0].encryptedData as EncryptedBlob,
    KEY,
  );
  assert.equal(clear.apiKey, "KEYnewnewnewnew9999");
});

test("saveCredential réinitialise le status à untested après ré-écriture", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY01ABCDEF0123456789" },
    KEY,
  );
  // Simule un test réussi.
  prisma.tenantCredentials[0].status = "ok";
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEYupdateupdate12345" },
    KEY,
  );
  assert.equal(prisma.tenantCredentials[0].status, "untested");
});

test("saveCredential rejette un tenant inconnu", async () => {
  const { prisma } = await seed();
  await assert.rejects(
    () =>
      saveCredential(
        asPrisma(prisma),
        "nope",
        "voip_telnyx",
        { apiKey: "KEY01ABCDEF0123456789" },
        KEY,
      ),
    (err: unknown) =>
      err instanceof CredentialError && err.code === "tenant_not_found",
  );
});

test("saveCredential rejette un kind inconnu", async () => {
  const { prisma, tenantId } = await seed();
  await assert.rejects(
    () =>
      saveCredential(
        asPrisma(prisma),
        tenantId,
        "voip_skype",
        { apiKey: "x" },
        KEY,
      ),
    (err: unknown) =>
      err instanceof CredentialError && err.code === "unknown_kind",
  );
});

test("saveCredential rejette des creds invalides", async () => {
  const { prisma, tenantId } = await seed();
  await assert.rejects(
    () =>
      saveCredential(
        asPrisma(prisma),
        tenantId,
        "voip_telnyx",
        { apiKey: "short" },
        KEY,
      ),
    (err: unknown) =>
      err instanceof CredentialError && err.code === "invalid_creds",
  );
});

// ─── listCredentials ────────────────────────────────────────────────────────

test("listCredentials ne renvoie JAMAIS de secret en clair", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEYsupersecret12345678" },
    KEY,
  );
  const list = await listCredentials(asPrisma(prisma), tenantId, KEY);
  assert.equal(list.length, 1);
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes("KEYsupersecret12345678"));
  assert.equal(list[0].masked.apiKey, "••••5678");
});

test("listCredentials retourne une liste vide quand aucun credential", async () => {
  const { prisma, tenantId } = await seed();
  const list = await listCredentials(asPrisma(prisma), tenantId, KEY);
  assert.deepEqual(list, []);
});

// ─── testCredential ─────────────────────────────────────────────────────────

test("testCredential persiste status=ok quand la connexion réussit", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY01ABCDEF0123456789" },
    KEY,
  );
  const result = await testCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    KEY,
    mockFetch(200),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(prisma.tenantCredentials[0].status, "ok");
  assert.equal(prisma.tenantCredentials[0].lastError, null);
  assert.ok(prisma.tenantCredentials[0].lastTestedAt);
});

test("testCredential persiste status=failed + lastError quand la connexion échoue", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY01ABCDEF0123456789" },
    KEY,
  );
  const result = await testCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    KEY,
    mockFetch(401),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(prisma.tenantCredentials[0].status, "failed");
  assert.ok(prisma.tenantCredentials[0].lastError);
});

test("testCredential rejette un credential absent", async () => {
  const { prisma, tenantId } = await seed();
  await assert.rejects(
    () =>
      testCredential(
        asPrisma(prisma),
        tenantId,
        "voip_telnyx",
        KEY,
        mockFetch(200),
      ),
    (err: unknown) =>
      err instanceof CredentialError &&
      err.code === "credential_not_found",
  );
});

// ─── deleteCredential ───────────────────────────────────────────────────────

test("deleteCredential supprime le credential", async () => {
  const { prisma, tenantId } = await seed();
  await saveCredential(
    asPrisma(prisma),
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY01ABCDEF0123456789" },
    KEY,
  );
  const result = await deleteCredential(asPrisma(prisma), tenantId, "voip_telnyx");
  assert.equal(result.deleted, true);
  assert.equal(prisma.tenantCredentials.length, 0);
});

test("deleteCredential est idempotent (no-op si absent)", async () => {
  const { prisma, tenantId } = await seed();
  const result = await deleteCredential(asPrisma(prisma), tenantId, "voip_telnyx");
  assert.equal(result.deleted, false);
});
