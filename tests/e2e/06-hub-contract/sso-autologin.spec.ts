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

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const ISSUE_PATH = "/api/sso.issueToken";
/** La forme que le Hub appelle réellement (lib/auth/bounce-apps.ts). */
const MAGIC_LINK_PATH = "/api/sso/issue-magic-link";
const EXCHANGE_PATH = "/api/sso.exchange";

const HUB_SECRET = process.env.HUB_HMAC_SECRET ?? "";
const E2E_EMAIL = process.env.SSO_E2E_EMAIL ?? "";

const PAYLOAD = { email: "sso-e2e-reject@veridian-test.local" };

async function postSigned(
  path: string,
  body: unknown,
  secret: string,
  opts: { timestampOverride?: number; signatureOverride?: string } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers = signHubRequest(rawBody, secret, opts.timestampOverride);
  if (opts.signatureOverride !== undefined) {
    headers["X-Veridian-Hub-Signature"] = opts.signatureOverride;
  }
  return fetch(`${target.engineUrl}${path}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/**
 * Réveille la cible et REFUSE de tester tant qu'elle dort.
 *
 * ⚠️ Piège vérifié sur staging le 2026-08-18 : la stack dort derrière Sablier,
 * et tant qu'elle démarre, le proxy répond **200 + une page HTML** « Veridian —
 * démarrage en cours » à N'IMPORTE QUELLE requête, y compris un POST non signé
 * sur une route qui n'existe pas.
 *
 * Conséquence pour les assertions de ce fichier :
 *   - `expect(status).not.toBe(404)` passe alors qu'aucune route n'est montée ;
 *   - `expect(status).toBe(401)` échoue alors que le guard est parfaitement en
 *     place.
 *
 * Autrement dit, sans ce garde, la suite rend un verdict sur le proxy et non
 * sur l'application — dans les deux sens, faux positif comme faux négatif.
 */
async function awakenTarget(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${target.engineUrl}/health`);
    lastStatus = res.status;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return; // l'app répond elle-même
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(
    `Cible ${target.engineUrl} encore endormie après 120s (dernier statut ${lastStatus}, ` +
      `réponse HTML = page de démarrage Sablier). Tester maintenant donnerait ` +
      `un verdict sur le proxy, pas sur l'application.`,
  );
}

test.describe(`SSO — contrat Hub issue-magic-link [${TARGET}]`, () => {
  test.skip(target.isDemo, "La démo n'expose pas le SSO Hub");

  test.beforeAll(awakenTarget);

  // Ce bloc existe parce que la route a été absente pendant tout le temps où
  // le Hub l'appelait : il prenait un 404 et le traduisait en « app
  // injoignable ». Un échec de contrat déguisé en panne d'infrastructure, la
  // pire façon d'échouer. Ces tests garantissent qu'on s'en apercevrait.

  test("la route que le Hub appelle est montée (le 404 est CE bug)", async () => {
    const res = await fetch(`${target.engineUrl}${MAGIC_LINK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    // 401 attendu (pas de signature). 404 = la route a disparu, et le Hub
    // recommencerait à annoncer « app injoignable ».
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  test("elle refuse une requête non signée, comme sso.issueToken", async () => {
    const res = await fetch(`${target.engineUrl}${MAGIC_LINK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("magic_link_url");
  });

  test("elle refuse une signature aléatoire", async () => {
    const res = await postSigned(MAGIC_LINK_PATH, PAYLOAD, "mauvais-secret");
    expect(res.status).toBe(401);
  });

  test("flux nominal : rend un magic_link_url exploitable par le Hub", async () => {
    test.skip(
      !HUB_SECRET || !E2E_EMAIL,
      "HUB_HMAC_SECRET + SSO_E2E_EMAIL requis",
    );

    const res = await postSigned(
      MAGIC_LINK_PATH,
      { email: E2E_EMAIL, hub_user_id: "e2e-hub-user" },
      HUB_SECRET,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { magic_link_url?: string };
    // La clé exacte : le Hub lève invalid_response sur toute autre.
    expect(typeof body.magic_link_url).toBe("string");

    // Les deux contraintes que le Hub applique avant de rediriger dessus.
    const url = new URL(body.magic_link_url as string);
    expect(url.protocol).toBe("https:");
    expect(url.host).toMatch(/\.veridian\.site$/);
    // Et le jeton reste dans le fragment, jamais en query string.
    expect(url.hash).toMatch(/^#[0-9a-f]{64}$/);
    expect(url.search).toBe("");
  });
});

test.describe(`SSO — rejets [${TARGET}]`, () => {
  test.skip(target.isDemo, "La démo n'expose pas le SSO Hub");

  test.beforeAll(awakenTarget);

  test("la route existe (ne renvoie plus 404)", async () => {
    // Ce test a une valeur historique : avant ce chantier, TOUTES les routes
    // SSO renvoyaient 404 et le client tombait sur un écran de login. Un
    // retour du 404 signifierait que le module n'est plus monté.
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).not.toBe(404);
  });

  test("émission sans signature → 401", async () => {
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test("émission sans timestamp → 401", async () => {
    const res = await fetch(`${target.engineUrl}${ISSUE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Veridian-Hub-Signature": "deadbeef".repeat(8),
      },
      body: JSON.stringify(PAYLOAD),
    });
    expect(res.status).toBe(401);
  });

  test("émission avec signature aléatoire → 401", async () => {
    const res = await postSigned(ISSUE_PATH, PAYLOAD, "secret-bidon", {
      signatureOverride: "ab".repeat(32),
    });
    expect(res.status).toBe(401);
  });

  test("émission avec un timestamp hors fenêtre → 401", async () => {
    const res = await postSigned(ISSUE_PATH, PAYLOAD, "secret-bidon", {
      timestampOverride: Date.now() - 10 * 60 * 1000,
    });
    expect(res.status).toBe(401);
  });

  test("un jeton inventé ne s'échange pas contre une session", async () => {
    // La route d'échange est publique par nécessité : sa seule protection est
    // l'imprévisibilité du jeton. On vérifie qu'elle ne cède pas.
    const res = await fetch(`${target.engineUrl}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ff".repeat(32) }),
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("access_token");
  });
});

test.describe(`SSO — flux nominal [${TARGET}]`, () => {
  test.skip(
    !HUB_SECRET || !E2E_EMAIL,
    "HUB_HMAC_SECRET et SSO_E2E_EMAIL requis (jamais commités)",
  );
  test.skip(target.isDemo, "La démo n'expose pas le SSO Hub");

  test("un jeton signé ouvre une session, et ne fonctionne qu'une fois", async () => {
    const res = await postSigned(ISSUE_PATH, { email: E2E_EMAIL }, HUB_SECRET);
    expect(res.status).toBe(200);

    const { autologin_url, expires_in } = await res.json();

    // Le jeton DOIT être dans le fragment. S'il repassait en query string, il
    // recommencerait à fuiter dans les logs d'accès et le Referer — c'est
    // précisément la régression que ce test doit attraper.
    expect(autologin_url).toContain("/sso#");
    expect(autologin_url).not.toContain("?t=");
    expect(expires_in).toBeLessThanOrEqual(300);

    const token = autologin_url.split("#")[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Premier échange : doit ouvrir une session utilisable.
    const first = await fetch(`${target.engineUrl}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(401);
  });

  test("un email inconnu est refusé avec un code exploitable par le Hub", async () => {
    // Renversement assumé de l'ancien test d'anti-énumération : la route est
    // derrière HubHmacGuard, et cet appel-ci EST signé. Qui arrive jusqu'ici
    // détient le secret maître ; lui masquer le motif ne protège personne et
    // prive le Hub du signal « ce client n'a pas de compte Analytics », dont
    // il a besoin pour afficher autre chose qu'un lien cassé (contrat Hub
    // §3.1). L'anti-énumération, elle, est portée par le guard : les tests de
    // rejet ci-dessus vérifient qu'un appel NON signé ne va nulle part.
    const res = await postSigned(
      ISSUE_PATH,
      { email: "personne-inexistante@veridian-test.local" },
      HUB_SECRET,
    );
    // 400 et non 404 : le client Hub (lib/auth/bounce-apps.ts) traite tout 404
    // comme « endpoint pas implémente ». Un 404 ici rendrait un client inconnu
    // indiscernable d'un engine pas deploye.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("user_not_in_app");
  });
});
