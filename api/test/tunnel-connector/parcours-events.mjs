#!/usr/bin/env node
/**
 * parcours-events.mjs — parcours d'events réaliste d'un prospect tunnel,
 * envoyé sur le RÉEL POST /api/track de l'engine staging.
 *
 * Usage :
 *   node parcours-events.mjs                 # parcours nominal (timestamps figés → rejouable)
 *   node parcours-events.mjs --replay        # REJOUE le MÊME parcours (mêmes dedup_token) → preuve idempotence
 *   node parcours-events.mjs --verify        # après le parcours : relit l'export ClickHouse par user_id
 *   node parcours-events.mjs --tenant-b      # émet sur le tenant B (preuve isolation multi-tenant)
 *
 * Conçu pour la Task #3 (e2e-prove). Le SCRIPT ne touche PAS Twenty directement :
 * il pousse les events à la source (comme un vrai navigateur via le SDK), c'est
 * le connecteur natif qui doit faire arriver la data dans Twenty. La vérif côté
 * Twenty se fait par le harness E2E (assertions REST sur REPLAY).
 *
 * INVARIANT IDEMPOTENCE : les dedup_token de l'engine sont
 *   pageview : `${session_id}_pv_${page_number}`
 *   goal     : `${session_id}_goal_${name}_${timestamp}`
 * → en figeant session_id ET les timestamps des goals, --replay produit
 *   exactement les mêmes event_id ⇒ le connecteur DOIT déduper (0 doublon).
 *
 * Zéro dépendance (fetch natif Node ≥ 18). Zéro mail réel. Zéro secret en dur.
 */

const ENGINE = process.env.ENGINE_URL ?? 'https://analytics-engine.staging.veridian.site';

// Workspaces (cf PLAN-E2E §2). Tenant B = à provisionner avant SPEC-5.
const WS_A = process.env.WS_A ?? 'vrd_veridian_site_staging';
const WS_B = process.env.WS_B ?? 'vrd_e2etestb_staging';

const args = new Set(process.argv.slice(2));
const TENANT_B = args.has('--tenant-b');
const WORKSPACE = TENANT_B ? WS_B : WS_A;
const VERIFY = args.has('--verify');

// === Identité figée du prospect de test (déterministe → rejouable) ===
// Doit correspondre à une Person seedée dans REPLAY avec auditSlug + emails +
// isTestProspect=true (le connecteur ne crée jamais de Person — §4c.2).
const SLUG = process.env.TEST_SLUG ?? 'acme-test-7h3k9x2p';            // identité outbound (audit)
const EMAIL_RAW = process.env.TEST_EMAIL ?? '  Bob.Test@EXAMPLE.COM '; // brut → doit être normalisé downstream
const EMAIL = EMAIL_RAW.trim().toLowerCase();                          // ce que Twenty doit avoir (SPEC-6a)

// session_id FIGÉ → dedup_token stables entre run nominal et --replay.
const SESSION_ID = process.env.TEST_SESSION_ID ?? `eprove-tunnel-fixed-session-01${TENANT_B ? '-b' : ''}`;

// Timestamps FIGÉS dans la fenêtre ±24h mais ancrés sur "il y a 1h" recalculé
// à chaque run. ⚠️ Pour l'idempotence stricte sur les GOALS, le dedup_token
// inclut le timestamp → on FIGE les offsets relatifs à une base arrondie à
// l'heure pour que deux runs proches retombent sur la même base. Si le run et
// le replay sont espacés de > 1h, relancer les deux d'affilée.
const HOUR_MS = 3600_000;
const BASE = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS; // début de l'heure précédente, stable
const t = (offsetSec) => BASE + offsetSec * 1000;

function log(...a) { console.log(...a); }
function fail(msg) { console.error('ROUGE:', msg); process.exitCode = 1; }

async function track(payload, label) {
  const res = await fetch(`${ENGINE}/api/track`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Origin réaliste (sinon domain restriction peut filtrer — cf isDomainAllowed)
      origin: 'https://veridian.site',
      referer: `https://veridian.site/audit/${SLUG}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const ok = res.status === 200;
  log(`  [${ok ? 'OK ' : 'ERR'}] ${label.padEnd(34)} HTTP ${res.status} ${ok ? '' : text.slice(0, 200)}`);
  if (!ok) fail(`${label} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return ok;
}

/** Une "session" staminads = 1 POST avec attributes + N actions, un user_id courant. */
function sessionPayload(userId, actions, createdOffset, updatedOffset) {
  return {
    workspace_id: WORKSPACE,
    session_id: SESSION_ID,
    user_id: userId,
    created_at: t(createdOffset),
    updated_at: t(updatedOffset),
    sent_at: Date.now(),
    sdk_version: 'eprove-e2e-1.0',
    attributes: {
      landing_page: `https://veridian.site/audit/${SLUG}`,
      referrer: 'https://mail.example.com/',
      device: 'desktop',
      browser: 'Chrome',
      os: 'Linux',
      language: 'fr',
      timezone: 'Europe/Paris',
    },
    actions,
  };
}

async function runParcours() {
  log(`\n=== Parcours tunnel ${TENANT_B ? '[TENANT B]' : '[TENANT A]'} ===`);
  log(`  engine    : ${ENGINE}`);
  log(`  workspace : ${WORKSPACE}`);
  log(`  slug      : ${SLUG}`);
  log(`  email     : "${EMAIL}" (brut: "${EMAIL_RAW}")`);
  log(`  session   : ${SESSION_ID}`);
  log(`  base ts   : ${new Date(BASE).toISOString()} (figé pour idempotence)\n`);

  // --- Phase 1 : prospect arrive via le mail → identify(slug), lit la page audit, scrolle, clique CTA.
  // user_id = slug. Pageview /audit/<slug> avec scroll 75 + goal cta_click.
  await track(
    sessionPayload(
      SLUG,
      [
        {
          type: 'pageview',
          path: `/audit/${SLUG}`,
          page_number: 1,
          duration: 95,
          scroll: 75,             // SPEC : scroll ≥ 75 sur la page audit
          entered_at: t(0),
          exited_at: t(95),
        },
        {
          type: 'goal',
          name: 'cta_click',       // goal name BRUT du site (le connecteur mappe → audit.cta_click)
          path: `/audit/${SLUG}`,
          page_number: 1,
          timestamp: t(90),        // FIGÉ → dedup_token stable
          properties: { cta: 'prendre_rdv' },
        },
      ],
      0,
      95,
    ),
    'phase1 identify(slug)+view+scroll+cta',
  );

  // --- Phase 1bis : le prospect navigue vers une HOT PAGE (/tarifs) avant de
  // donner son email. Exerce l'agrégat hotPages (HOT_PATHS = /tarifs,/contact,/roi).
  // Toujours user_id = slug (pas encore identifié par email).
  await track(
    sessionPayload(
      SLUG,
      [
        {
          type: 'pageview',
          path: '/tarifs',          // HOT_PAGE → +15 (agrégat hotPages, SPEC endpoint)
          page_number: 2,
          duration: 40,
          scroll: 50,
          entered_at: t(96),
          exited_at: t(136),
        },
      ],
      96,
      136,
    ),
    'phase1bis hot page /tarifs',
  );

  // --- Phase 2 : le prospect donne son email (form/RDV) → identify(email).
  // La session courante est ré-attribuée à l'email (rétro-attribution staminads).
  // On re-poste le pageview audit (même page_number → même dedup_token : idempotent
  // côté events) MAIS avec user_id=email, + le goal rdv_booked.
  await track(
    sessionPayload(
      EMAIL,                       // bascule slug → email
      [
        {
          type: 'pageview',
          path: `/audit/${SLUG}`,
          page_number: 1,
          duration: 140,
          scroll: 90,
          entered_at: t(0),
          exited_at: t(140),
        },
        {
          type: 'goal',
          name: 'rdv_booked',      // → audit.rdv (signal le plus chaud, +50)
          path: `/audit/${SLUG}`,
          page_number: 1,
          timestamp: t(135),       // FIGÉ
          properties: { source: 'cal.com' },
        },
      ],
      0,
      140,
    ),
    'phase2 identify(email)+rdv_booked',
  );

  log('\nParcours émis. Le connecteur doit, sous ~15s (tick worker 10s) :');
  log('  - résoudre la Person (slug puis email → même record)');
  log('  - poser timeline audit.page_view / audit.scroll / audit.cta_click / audit.rdv');
  log('  - PATCH score (RDV = signal chaud) + components');
  log('  - chaque happensAt = vraie heure (base ts ci-dessus, PAS maintenant)\n');
}

/** Vérifie l'arrivée dans ClickHouse via l'export (preuve SPEC-2). */
async function verifyExport() {
  const adminKey = process.env.ENGINE_ADMIN_KEY;
  if (!adminKey) {
    log('  (skip --verify : ENGINE_ADMIN_KEY non fourni — export protégé par JWT/API key)');
    return;
  }
  for (const uid of [SLUG, EMAIL]) {
    const url = `${ENGINE}/api/export.userEvents?workspace_id=${WORKSPACE}&user_id=${encodeURIComponent(uid)}&limit=50`;
    const res = await fetch(url, { headers: { 'x-api-key': adminKey } });
    const txt = await res.text();
    log(`  export user_id=${uid} → HTTP ${res.status} ${txt.slice(0, 160)}`);
  }
}

(async () => {
  await runParcours();
  if (VERIFY) await verifyExport();
  log(args.has('--replay')
    ? '\n>>> MODE REPLAY : mêmes dedup_token émis. Twenty doit montrer 0 nouvelle timelineActivity (idempotence SPEC-3e).'
    : '\n>>> Run nominal terminé. Lancer --replay juste après pour prouver l\'idempotence.');
})();
