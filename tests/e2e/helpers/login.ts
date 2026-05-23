/**
 * Login helper — bootstrap d'une session authentifiée pour les tests UI.
 *
 * Stratégie : on appelle directement `/api/auth.login` ou `/api/demo.login`,
 * on extrait le `access_token` (JWT) et on l'injecte dans le localStorage du
 * browser Playwright sous la clé attendue par la console staminads
 * (`stm_token` ou `auth_token` selon version — on essaie les deux).
 *
 * Pour les tests E2E qui ont besoin de la console authentifiée :
 *   - demo target : `loginDemo(page, target)` — auto-login anonyme, marche
 *     toujours sur demo-prod / demo-staging
 *   - staging/prod : `loginAdmin(page, target, { email, password })` — credentials
 *     fournis via GitHub Secrets `E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD`. Si
 *     manquants → `test.skip()` propre (pas d'erreur).
 *
 * Important : on NE crée pas d'utilisateur. On consomme un user existant
 * (admin déjà bootstrap en staging/prod, demo user déjà seedé en démo).
 */

import type { Page } from "@playwright/test";
import type { Target } from "./targets";
import { ApiClient } from "./api-client";

export interface LoginResult {
  accessToken: string;
  userId?: string;
  email?: string;
}

/** Storage keys candidats pour le JWT côté console staminads. */
const TOKEN_STORAGE_KEYS = [
  "stm_token",
  "auth_token",
  "access_token",
  "staminads_token",
];

/**
 * Login anonyme démo (POST /api/demo.login).
 * Marche systématiquement sur les cibles `target.isDemo === true`.
 */
export async function loginDemo(
  page: Page,
  target: Target,
): Promise<LoginResult> {
  if (!target.isDemo) {
    throw new Error(
      `loginDemo() requires a demo target, got "${target.name}"`,
    );
  }
  const client = new ApiClient(target.consoleUrl);
  const res = await client.post("/api/demo.login", {}, { timeoutMs: 15_000 });
  if (res.status !== 200) {
    throw new Error(
      `demo.login failed status=${res.status} body=${res.body.slice(0, 200)}`,
    );
  }
  const body = res.json() as {
    access_token: string;
    user?: { id: string; email: string };
  };
  await injectToken(page, target, body.access_token);
  return {
    accessToken: body.access_token,
    userId: body.user?.id,
    email: body.user?.email,
  };
}

/**
 * Login admin classique (POST /api/auth.login).
 * Skip propre si credentials manquants (CI sans secret).
 */
export async function loginAdmin(
  page: Page,
  target: Target,
  creds: { email?: string; password?: string } = {},
): Promise<LoginResult | null> {
  const email = creds.email ?? process.env.E2E_ADMIN_EMAIL;
  const password = creds.password ?? process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    return null; // caller doit gérer le skip
  }
  const client = new ApiClient(target.consoleUrl);
  const res = await client.post(
    "/api/auth.login",
    { email, password },
    { timeoutMs: 15_000 },
  );
  if (res.status !== 200) {
    throw new Error(
      `auth.login failed status=${res.status} body=${res.body.slice(0, 200)}`,
    );
  }
  const body = res.json() as {
    access_token: string;
    user?: { id: string; email: string };
  };
  await injectToken(page, target, body.access_token);
  return {
    accessToken: body.access_token,
    userId: body.user?.id,
    email: body.user?.email,
  };
}

/**
 * Injecte le JWT dans le localStorage du browser pour toutes les clés
 * candidates connues (compat versions différentes du SDK).
 */
async function injectToken(
  page: Page,
  target: Target,
  token: string,
): Promise<void> {
  // On doit d'abord naviguer sur le domaine (sinon localStorage.setItem refuse
  // SecurityError: no origin). On va sur une page légère.
  if (!page.url().startsWith(target.consoleUrl)) {
    await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }
  await page.evaluate(
    ({ token, keys }: { token: string; keys: string[] }) => {
      for (const k of keys) {
        try {
          window.localStorage.setItem(k, token);
        } catch {
          /* ignore */
        }
      }
    },
    { token, keys: TOKEN_STORAGE_KEYS },
  );
}
