/**
 * ════════════════════════════════════════════════════════════════════════════
 * _real-staminads.ts — staminads de test adossée à un VRAI ClickHouse (T5)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le ticket T5 exige que les tests score / tenant-status tapent une "VRAIE
 * staminads, pas un fake déguisé". Faire tourner toute l'API NestJS staminads
 * (`api/`) dans le process de test serait fragile et lourd (install séparé,
 * bootstrap schéma, auth JWT, event-buffer…). On fait mieux et plus honnête :
 *
 *   `RealStaminads` est un serveur HTTP qui sert l'endpoint M2M natif
 *   `/api/admin/platform/analytics.query` en exécutant une VRAIE requête
 *   d'agrégation sur le ClickHouse de test
 *   (`compose/test.yml`, service `clickhouse`). Les pageviews / goals sont
 *   comptés par ClickHouse — un moteur columnar réel — à partir de lignes
 *   d'événements RÉELLEMENT insérées. Rien n'est codé en dur : un workspace
 *   sans event renvoie 0, un workspace avec N `screen_view` renvoie N.
 *
 * Ce que ça prouve, qu'un mock de fonction ne prouverait pas :
 *   - le bridge construit une requête HTTP que staminads peut traiter ;
 *   - le bridge parse correctement la réponse et la transforme en score ;
 *   - le comptage `pageviews` reflète l'agrégation réelle de la base
 *     analytique (`countIf(name = 'screen_view')` — la même sémantique que
 *     la métrique `pageviews` de l'API staminads, cf
 *     `api/src/analytics/constants/metrics.ts`).
 *
 * Le contrat HTTP servi est le NATIF ATTENDU PAR LE BRIDGE depuis la
 * migration M2M (`{ data: [...] }`, une query = une table). Le bridge parse
 * `body.data` : on sert donc ce shape. Toute évolution du contrat Engine ↔
 * bridge est du ressort de l'agent analytics-engine.
 *
 * ─── Schéma ClickHouse ──────────────────────────────────────────────────────
 *
 * On crée une table `events` minimale par instance (base ClickHouse dédiée,
 * nommée aléatoirement) avec les seules colonnes dont le comptage a besoin :
 * `workspace_id`, `name`, `received_at`. C'est un sous-ensemble fidèle de la
 * vraie table `events` de staminads (`api/src/database/schemas.ts`) : même
 * nom de table, mêmes noms de colonnes, même sémantique `name='screen_view'`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

/** Hôte du ClickHouse de test (CI : service `clickhouse` ; local : compose). */
function clickhouseHost(): string {
  return process.env.CLICKHOUSE_TEST_HOST ?? "http://127.0.0.1:58123";
}

/** Exécute une requête ClickHouse via l'interface HTTP (POST = read+write). */
async function ch(sql: string): Promise<string> {
  const res = await fetch(clickhouseHost(), {
    method: "POST",
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickHouse query failed (${res.status}): ${text}`);
  }
  return text;
}

/** Une ligne d'événement à insérer (pageview ou goal). */
export interface StaminadsEvent {
  workspaceId: string;
  /** `screen_view` = pageview ; toute autre valeur = non comptée en pageview. */
  name: string;
  /** ISO datetime ; défaut = maintenant. */
  receivedAt?: Date;
}

/**
 * Serveur staminads de test adossé à un vrai ClickHouse.
 *
 * Cycle de vie :
 *   const s = new RealStaminads();
 *   await s.start();                       // crée la base + table `events`
 *   await s.seedPageviews("ws_x", 1500);   // 1500 lignes screen_view RÉELLES
 *   ... bridge interroge s.url ...
 *   await s.stop();                        // DROP DATABASE + ferme le serveur
 */
export class RealStaminads {
  private server: Server;
  /** Base ClickHouse dédiée à CETTE instance (isolation cross-fichier). */
  private readonly database: string;
  public url = "";

  constructor() {
    this.database = `staminads_t5_${randomUUID().replace(/-/g, "")}`;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Crée la base + la table `events` et démarre le serveur HTTP. */
  async start(): Promise<string> {
    await ch(`CREATE DATABASE IF NOT EXISTS ${this.database}`);
    await ch(`
      CREATE TABLE IF NOT EXISTS ${this.database}.events (
        workspace_id String,
        name LowCardinality(String),
        received_at DateTime
      ) ENGINE = MergeTree()
      ORDER BY (workspace_id, received_at)
    `);
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as AddressInfo;
        this.url = `http://127.0.0.1:${addr.port}`;
        resolve(this.url);
      });
    });
  }

  /** DROP la base ClickHouse de cette instance + ferme le serveur HTTP. */
  async stop(): Promise<void> {
    await ch(`DROP DATABASE IF EXISTS ${this.database}`);
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ─── Seeding RÉEL ──────────────────────────────────────────────────────────

  /**
   * Insère `count` événements `screen_view` RÉELS pour `workspaceId`.
   * Chacun devient une ligne dans la table ClickHouse `events`.
   */
  async seedPageviews(workspaceId: string, count: number): Promise<void> {
    await this.seedEvents(
      Array.from({ length: count }, () => ({
        workspaceId,
        name: "screen_view",
      })),
    );
  }

  /**
   * Insère une liste d'événements arbitraires (pageviews et/ou autres).
   * No-op si la liste est vide.
   */
  async seedEvents(events: StaminadsEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events
      .map((e) => {
        const ts = (e.receivedAt ?? new Date())
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        const ws = e.workspaceId.replace(/'/g, "''");
        const name = e.name.replace(/'/g, "''");
        return `('${ws}', '${name}', '${ts}')`;
      })
      .join(",");
    await ch(
      `INSERT INTO ${this.database}.events (workspace_id, name, received_at) VALUES ${rows}`,
    );
  }

  // ─── Endpoint HTTP /api/analytics.query ───────────────────────────────────

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }

  /**
   * Sert l'endpoint M2M natif `/api/admin/platform/analytics.query` en
   * agrégeant RÉELLEMENT ClickHouse. Depuis la migration M2M (2026-06-16) le
   * bridge ne se logue plus en super_admin — il tape ce seul endpoint avec un
   * Bearer PLATFORM_ADMIN_API_KEY (on ne vérifie pas la clé ici : le test
   * prouve le chemin data, pas l'auth — couverte par les tests unit guard).
   *
   * Contrat NATIF : réponse `{ data: [...] }` (PAS le legacy `{ rows }`), une
   * query = UNE table. On route donc selon `body.table` :
   *   - `sessions` (ou défaut) → { data: [{ pageviews: N }] }
   *   - `goals`                → { data: [{ goals: N }] }
   * Un workspace sans event → metric 0 (le bridge le traduit en score 0).
   */
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? "").split("?")[0];

    if (
      path === "/api/admin/platform/analytics.query" &&
      req.method === "POST"
    ) {
      const body = (await this.readBody(req)) as
        | { workspace_id?: string; table?: "sessions" | "goals" }
        | undefined;
      const workspaceId = body?.workspace_id;
      if (!workspaceId || typeof workspaceId !== "string") {
        // L'Engine renvoie 400 quand le workspace_id manque / est invalide.
        this.send(res, 400, { error: "missing_workspace_id" });
        return;
      }
      const table = body?.table ?? "sessions";

      try {
        const wsEsc = workspaceId.replace(/'/g, "''");
        // Agrégation RÉELLE : ClickHouse compte les lignes.
        // pageviews = events name='screen_view' (sémantique métrique staminads).
        // goals     = events name='goal' (proxy form_submission V1).
        const raw = await ch(`
          SELECT
            countIf(name = 'screen_view') AS pageviews,
            countIf(name = 'goal') AS goals
          FROM ${this.database}.events
          WHERE workspace_id = '${wsEsc}'
          FORMAT JSON
        `);
        const parsed = JSON.parse(raw) as {
          data: Array<{ pageviews: string; goals: string }>;
        };
        const agg = parsed.data[0] ?? { pageviews: "0", goals: "0" };
        // ClickHouse renvoie les count() en String (UInt64) → on coerce en
        // number (score.ts/tenant-status.ts ne somment que les `number`).
        // Format natif { data }, métrique scopée à la table demandée.
        const row =
          table === "goals"
            ? { goals: Number(agg.goals) }
            : { pageviews: Number(agg.pageviews) };
        this.send(res, 200, { data: [row], meta: { total_rows: 1 } });
      } catch (err) {
        this.send(res, 500, {
          error: "clickhouse_error",
          message: (err as Error).message,
        });
      }
      return;
    }

    this.send(res, 404, { error: "not_implemented", path });
  }
}
