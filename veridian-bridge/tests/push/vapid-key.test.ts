/**
 * Tests vapid-key — GET /api/push/vapid-key + getVapidPublicKey().
 *
 * Couvre :
 *   - retourne la clé publique configurée
 *   - CORS public ouvert
 *   - OPTIONS preflight 204
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerPushRoutes } from "../../src/push/routes.js";
import {
  _resetForTests,
  configureWebPush,
  getVapidPublicKey,
} from "../../src/push/index.js";
import { FakePrismaClient } from "../helpers/fake-prisma.js";

const VAPID_PUBLIC = "BMa9I_teR6iZfP09lzwy8HnI9fU77rUVajmJTmWv0Iiy7V3R5trzNRdJj1DZt8ewb_-VFX3ZEig190bA5tx6qUo";
const VAPID_PRIVATE = "y5VCetmsjhLXCaaSDjtVQ_KfKkQNcOV6qne7TpjdS_k";

function makeApp(prisma: FakePrismaClient) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization");
    if (auth === "Bearer test-admin-key") return next();
    res.status(401).json({ error: "unauthorized" });
  };
  registerPushRoutes(app, {
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    requireAdmin,
  });
  return app;
}

function startServer(app: ReturnType<typeof makeApp>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

test("getVapidPublicKey returns configured public key", () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  assert.equal(getVapidPublicKey(), VAPID_PUBLIC);
});

test("getVapidPublicKey returns empty string if not configured", () => {
  _resetForTests();
  assert.equal(getVapidPublicKey(), "");
});

test("GET /api/push/vapid-key returns public key + CORS *", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/vapid-key`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = (await res.json()) as { publicKey: string };
    assert.equal(body.publicKey, VAPID_PUBLIC);
  } finally {
    await close();
  }
});

test("OPTIONS /api/push/subscribe returns 204 with CORS headers", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/subscribe`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(res.headers.get("access-control-allow-methods")?.includes("POST"));
  } finally {
    await close();
  }
});

test("configureWebPush throws PushConfigError if keys missing", () => {
  _resetForTests();
  assert.throws(
    () =>
      configureWebPush({
        publicKey: "",
        privateKey: VAPID_PRIVATE,
        subject: "mailto:test@veridian.site",
      }),
    /VAPID_PUBLIC_KEY/,
  );
});

test("configureWebPush throws if subject invalid", () => {
  _resetForTests();
  assert.throws(
    () =>
      configureWebPush({
        publicKey: VAPID_PUBLIC,
        privateKey: VAPID_PRIVATE,
        subject: "not-a-subject",
      }),
    /mailto/,
  );
});
