/**
 * Workspace test helpers — création + cleanup de workspaces isolés.
 *
 * Chaque test qui a besoin d'un workspace doit en créer un dédié avec un
 * uuid unique pour ne JAMAIS toucher aux workspaces clients réels. Le cleanup
 * se fait dans `afterAll` via `cleanupTestWorkspace`.
 *
 * Pattern :
 *   ```ts
 *   const ctx = await createTestWorkspace(client, { adminToken });
 *   // ... tests using ctx.workspaceId / ctx.siteKey ...
 *   await cleanupTestWorkspace(client, ctx, { adminToken });
 *   ```
 *
 * Si pas de adminToken (CI sans secret) → returns null + test.skip() chez le caller.
 */

import { randomUUID } from "node:crypto";
import type { ApiClient } from "./api-client";

export interface TestWorkspaceCtx {
  workspaceId: string;
  workspaceName: string;
  siteKey: string;
  createdAt: number;
}

export interface CreateOpts {
  adminToken: string;
  /** Préfixe du nom workspace (default "e2e-test"). */
  prefix?: string;
  /** Timeout création (default 15s). */
  timeoutMs?: number;
}

/**
 * Crée un workspace de test isolé avec uuid unique.
 *
 * Si la création échoue (pas de droits, endpoint changé), throw avec détail.
 * Pour skip gracieux côté test, le caller doit checker `adminToken` avant.
 */
export async function createTestWorkspace(
  client: ApiClient,
  opts: CreateOpts,
): Promise<TestWorkspaceCtx> {
  const uuid = randomUUID();
  const workspaceName = `${opts.prefix ?? "e2e-test"}-${uuid.slice(0, 8)}`;
  const res = await client.post(
    "/api/workspace.create",
    {
      name: workspaceName,
      timezone: "Europe/Paris",
    },
    {
      headers: { Authorization: `Bearer ${opts.adminToken}` },
      timeoutMs: opts.timeoutMs ?? 15_000,
      allowFailure: true,
    },
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `workspace.create failed status=${res.status} body=${res.body.slice(0, 200)}`,
    );
  }
  const body = res.json() as {
    workspace?: { id: string; site_key?: string };
    id?: string;
    site_key?: string;
  };
  const workspaceId = body.workspace?.id ?? body.id ?? "";
  const siteKey = body.workspace?.site_key ?? body.site_key ?? "";
  if (!workspaceId) {
    throw new Error(
      `workspace.create returned no id: body=${res.body.slice(0, 200)}`,
    );
  }
  return {
    workspaceId,
    workspaceName,
    siteKey,
    createdAt: Date.now(),
  };
}

/**
 * Cleanup workspace de test. Best-effort : un fail ici ne doit pas casser
 * le test (on log mais on n'arrête pas).
 */
export async function cleanupTestWorkspace(
  client: ApiClient,
  ctx: TestWorkspaceCtx,
  opts: { adminToken: string },
): Promise<void> {
  try {
    await client.post(
      "/api/workspace.delete",
      { workspace_id: ctx.workspaceId },
      {
        headers: { Authorization: `Bearer ${opts.adminToken}` },
        timeoutMs: 10_000,
        allowFailure: true,
      },
    );
  } catch (err) {
    // best-effort, log mais ne fail pas
    console.warn(
      `cleanup workspace ${ctx.workspaceId} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Génère un site key fake (jamais déclaré côté serveur) pour tester les
 * rejets d'auth (`invalid sitekey 404`).
 */
export function fakeSiteKey(): string {
  return `stm_pub_e2e_fake_${randomUUID().slice(0, 12)}`;
}
