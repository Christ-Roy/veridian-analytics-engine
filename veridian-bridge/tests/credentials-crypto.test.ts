/**
 * Tests unitaires — chiffrement AES-256-GCM des credentials (U8).
 *
 * Couvre `src/credentials/crypto.ts` :
 *   - encrypt/decrypt round-trip sur objet JSON arbitraire
 *   - tamper detection (clé invalide, blob altéré)
 *   - validation de la clé hex
 *   - readEncryptionKeyFromEnv
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptJson,
  decryptJson,
  readEncryptionKeyFromEnv,
  CredentialCryptoError,
  type EncryptedBlob,
} from "../src/credentials/crypto.js";

const KEY = "a".repeat(64);

test("encryptJson / decryptJson round-trip sur creds OVH", () => {
  const creds = {
    applicationKey: "ovh-app-key-12345",
    applicationSecret: "ovh-app-secret-67890",
    consumerKey: "ovh-consumer-key-abcde",
    endpoint: "ovh-eu",
  };
  const blob = encryptJson(creds, KEY);
  assert.equal(blob.v, 1);
  assert.match(blob.iv, /^[0-9a-f]{24}$/);
  assert.match(blob.tag, /^[0-9a-f]{32}$/);
  assert.ok(blob.ciphertext.length > 0);
  // Le clear-text ne doit JAMAIS apparaître dans le ciphertext.
  assert.ok(!blob.ciphertext.includes("ovh-app-secret"));
  assert.notEqual(blob.ciphertext, JSON.stringify(creds));

  const decoded = decryptJson(blob, KEY);
  assert.deepEqual(decoded, creds);
});

test("encryptJson / decryptJson round-trip sur creds Telnyx", () => {
  const creds = { apiKey: "KEY01ABCDEF0123456789" };
  const blob = encryptJson(creds, KEY);
  assert.ok(!blob.ciphertext.includes("KEY01ABCDEF"));
  assert.deepEqual(decryptJson(blob, KEY), creds);
});

test("decryptJson échoue avec une mauvaise clé", () => {
  const blob = encryptJson({ apiKey: "secret" }, KEY);
  assert.throws(() => decryptJson(blob, "b".repeat(64)));
});

test("decryptJson échoue si le ciphertext est altéré (tag GCM)", () => {
  const blob = encryptJson({ apiKey: "secret" }, KEY);
  const tampered: EncryptedBlob = {
    ...blob,
    ciphertext: blob.ciphertext.replace(/.$/, (c) =>
      c === "0" ? "1" : "0",
    ),
  };
  assert.throws(() => decryptJson(tampered, KEY));
});

test("decryptJson rejette un blob malformé", () => {
  assert.throws(
    () => decryptJson({ v: 1 } as unknown as EncryptedBlob, KEY),
    CredentialCryptoError,
  );
});

test("encryptJson rejette une clé de mauvaise longueur", () => {
  assert.throws(
    () => encryptJson({ x: 1 }, "deadbeef"),
    CredentialCryptoError,
  );
});

test("encryptJson rejette une clé non-hex", () => {
  assert.throws(
    () => encryptJson({ x: 1 }, "z".repeat(64)),
    CredentialCryptoError,
  );
});

test("deux chiffrements du même objet produisent des blobs différents (IV)", () => {
  const creds = { apiKey: "same-secret" };
  const a = encryptJson(creds, KEY);
  const b = encryptJson(creds, KEY);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  // Mais les deux déchiffrent vers la même valeur.
  assert.deepEqual(decryptJson(a, KEY), decryptJson(b, KEY));
});

test("readEncryptionKeyFromEnv lit TOKEN_ENCRYPTION_KEY", () => {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    assert.equal(readEncryptionKeyFromEnv(), KEY);
  } finally {
    if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prev;
  }
});

test("readEncryptionKeyFromEnv throw si absente", () => {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => readEncryptionKeyFromEnv(), CredentialCryptoError);
  } finally {
    if (prev !== undefined) process.env.TOKEN_ENCRYPTION_KEY = prev;
  }
});

test("readEncryptionKeyFromEnv throw si mal formée", () => {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    process.env.TOKEN_ENCRYPTION_KEY = "tooshort";
    assert.throws(() => readEncryptionKeyFromEnv(), CredentialCryptoError);
  } finally {
    if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prev;
  }
});
