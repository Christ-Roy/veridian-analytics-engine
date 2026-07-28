/**
 * 06-hub-contract — Autologin SSO Hub → Analytics.
 *
 * Vérifie contre un environnement RÉEL que la couche SSO tient ses promesses.
 * Les tests unitaires couvrent la logique ; ici on veut la preuve que les
 * routes sont bien montées, que le secret est bien injecté dans le conteneur,
 * et qu'un vrai jeton ouvre une vraie session.
 *
 * Deux niveaux :
 *
 *   1. **Rejets** — ne demandent aucun secret, tournent partout. C'est la
 *      partie qui protège contre une régression ouvrant la route par accident
 *      (guard retiré, `rawBody` disparu du bootstrap, secret non injecté).
 *
 *   2. **Flux nominal** — exige le secret HMAC, fourni via `HUB_HMAC_SECRET`
 *      dans l'environnement du runner. Sans lui, ces tests sont SKIPPÉS et non
 *      échoués : le secret n'a rien à faire dans le dépôt.
 *
 * Le flux nominal a besoin d'un compte existant sur la cible, désigné par
 * `SSO_E2E_EMAIL`. Il ouvre une vraie session pour ce compte — donc à réserver
 * à staging.
 */

import { test, expect } from '@playwright/test';
import { getTarget, type TargetName } from '../helpers/targets';
import { signHubRequest } from '../helpers/hub-hmac';

const TARGET = (process.env.TARGET ?? 'staging') as TargetName;
const target = getTarget(TARGET);

const ISSUE_PATH = '/api/sso.issueToken';
const EXCHANGE_PATH = '/api/sso.exchange';

const HUB_SECRET = process.env.HUB_HMAC_SECRET ?? '';
const E2E_EMAIL = process.env.SSO_E2E_EMAIL ?? '';

const PAYLOAD = { email: 'sso-e2e-reject@veridian-test.local' };

async function postSigned(
  path: string,
  body: unknown,
  secret: string,
  opts: { timestampOverride?: number; signatureOverride?: string } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers = signHubRequest(rawBody, secret, opts.timestampOverride);
  if (opts.signatureOverride !== undefined) {
    headers['X-Veridian-Hub-Signature'] = opts.signatureOverride;
  }
  return fetch(`${target.engineUrl}${path}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

test.describe(`SSO — rejets [${TARGET}]`, () => {
  test.skip(target.isDemo, "La démo n'expose pas le SSO Hub");

  test('la route existe (ne renvoie plus 404)', async () => {
    // Ce test a une valeur historique : avant ce chantier, TOUTES les routes
    // SSO renvoyaient 404 et le client tombait sur un écran de login. Un
    // retour du 404 signifierait que le module n'est plus monté.
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).not.toBe(404);
  });

  test('émission sans signature → 401', async () => {
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test('émission sans timestamp → 401', async () => {
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Veridian-Hub-Signature': 'deadbeef'.repeat(8),
      },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test('émission avec signature aléatoire → 401', async () => {
    const res = await postSigned(ISSUE_PATH, PAYLOAD, 'secret-bidon', {
      signatureOverride: 'ab'.repeat(32),
    });
    expect(res.status).toBe(401);
  });

  test('émission avec un timestamp hors fenêtre → 401', async () => {
    const res = await postSigned(ISSUE_PATH, PAYLOAD, 'secret-bidon', {
      timestampOverride: Date.now() - 10 * 60 * 1000,
    });
    expect(res.status).toBe(401);
  });

  test('un jeton inventé ne s\'échange pas contre une session', async () => {
    // La route d'échange est publique par nécessité : sa seule protection est
    // l'imprévisibilité du jeton. On vérifie qu'elle ne cède pas.
    const res = await fetch(`${target.engineUrl}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ff'.repeat(32) }),
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('access_token');
  });
});

test.describe(`SSO — flux nominal [${TARGET}]`, () => {
  test.skip(
    !HUB_SECRET || !E2E_EMAIL,
    'HUB_HMAC_SECRET et SSO_E2E_EMAIL requis (jamais commités)',
  );
  test.skip(target.isDemo, "La démo n'expose pas le SSO Hub");

  test('un jeton signé ouvre une session, et ne fonctionne qu\'une fois', async () => {
    const res = await postSigned(ISSUE_PATH, { email: E2E_EMAIL }, HUB_SECRET);
    expect(res.status).toBe(200);

    const { autologin_url, expires_in } = await res.json();

    // Le jeton DOIT être dans le fragment. S'il repassait en query string, il
    // recommencerait à fuiter dans les logs d'accès et le Referer — c'est
    // précisément la régression que ce test doit attraper.
    expect(autologin_url).toContain('/sso#');
    expect(autologin_url).not.toContain('?t=');
    expect(expires_in).toBeLessThanOrEqual(300);

    const token = autologin_url.split('#')[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Premier échange : doit ouvrir une session utilisable.
    const first = await fetch(`${target.engineUrl}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    const session = await first.json();
    expect(session.access_token).toBeTruthy();
    expect(session.user.email).toBe(E2E_EMAIL.toLowerCase());

    // Le JWT obtenu doit réellement authentifier auprès de l'API — sinon on
    // aurait livré un jeton décoratif.
    const me = await fetch(`${target.engineUrl}/api/auth.sessions`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    expect(me.status).toBe(200);

    // Rejeu : le même jeton ne doit plus rien ouvrir.
    const replay = await fetch(`${target.engineUrl}${EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(401);
  });

  test('un email inconnu est indiscernable d\'un compte non éligible', async () => {
    // Anti-énumération : le Hub ne doit pas pouvoir se servir de cette route
    // pour découvrir quels emails ont un compte.
    const res = await postSigned(
      ISSUE_PATH,
      { email: 'personne-inexistante@veridian-test.local' },
      HUB_SECRET,
    );
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('not found');
    expect(body).not.toContain('unknown');
  });
});
