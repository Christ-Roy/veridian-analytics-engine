/**
 * SECU P0 — Guard logic pour la page `/setup` (bootstrap admin).
 *
 * Extrait de `routes/setup.tsx` pour pouvoir être testé unitairement
 * sans embarquer TanStack Router. Le caller (le `beforeLoad` de la route)
 * appelle `shouldBlockSetupAccess()` et `throw redirect(...)` si true.
 *
 * Comportement fail-CLOSED : si l'API `/api/setup.status` est down, on
 * BLOQUE l'accès à `/setup`. Principe fail-safe defaults (Saltzer & Schroeder).
 *
 * Bug d'origine (BUG-01, audit 2026-05-23) : la version précédente du
 * `beforeLoad` avait un try/catch qui swallow le `throw redirect()` parce
 * que les conditions du catch ne reconnaissaient pas l'objet redirect de
 * TanStack Router → le form de bootstrap admin s'affichait publiquement
 * même quand l'admin était déjà créé.
 */

export type SetupStatusFetcher = () => Promise<Response>;

/**
 * Décide si l'accès à `/setup` doit être bloqué (redirect /login).
 *
 * Retourne `true` (= block) dans tous les cas SAUF :
 *   - API a répondu 200 ET `setupCompleted === false`
 *
 * Tout autre cas (réseau cassé, parse error, 5xx, etc.) → block.
 */
export async function shouldBlockSetupAccess(
  fetcher: SetupStatusFetcher = () => fetch('/api/setup.status'),
): Promise<boolean> {
  try {
    const res = await fetcher();
    if (!res.ok) {
      // 4xx / 5xx → fail-closed
      return true;
    }
    const body = (await res.json()) as { setupCompleted?: unknown };
    // Seul `setupCompleted === false` (boolean strict) autorise l'accès.
    // Tout autre valeur (true, undefined, non-boolean, etc.) → block.
    return body.setupCompleted !== false;
  } catch {
    // Réseau cassé / JSON invalide / fetch reject → fail-closed
    return true;
  }
}
