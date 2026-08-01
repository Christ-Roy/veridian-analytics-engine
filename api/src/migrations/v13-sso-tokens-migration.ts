import { ClickHouseClient } from '@clickhouse/client';
import { MajorMigration } from './migration.interface';

/**
 * V13 SSO Migration
 *
 * Crée la table `sso_login_tokens` dans la system database : les jetons
 * d'autologin émis par le Hub pour ouvrir une session Analytics sans que le
 * client ait à ressaisir un mot de passe (couche 1 du contrat SSO,
 * cf. todo/2026-06-22-sso-autologin-hub-issue-token.md).
 *
 * Pourquoi une table dédiée et PAS une réutilisation de `password_reset_tokens` :
 * ce sont deux pouvoirs différents. Un jeton de reset permet de CHANGER un mot
 * de passe (et exige donc une action utilisateur), un jeton SSO OUVRE une
 * session directement. Les mélanger dans la même table, c'est prendre le risque
 * qu'un bug de filtrage laisse un jeton d'un type être consommé par le flux de
 * l'autre — soit une élévation de privilège silencieuse. Séparés, la confusion
 * de type est structurellement impossible.
 *
 * Modèle de sécurité porté par les colonnes :
 *   - `token_hash` : SHA-256 du jeton. Le jeton en clair n'existe QUE dans la
 *     réponse à l'émission et dans l'URL remise au navigateur. Une fuite de la
 *     base ne permet donc de rejouer aucun jeton.
 *   - `workspace_id` : le workspace auquel le jeton est LIÉ à l'émission.
 *     C'est la défense contre la fuite entre tenants : un jeton ne peut pas
 *     ouvrir la session d'un workspace qu'il ne nomme pas. Vide = le Hub n'a
 *     pas su nommer le workspace, la consommation retombe alors sur le premier
 *     workspace du user (jamais sur un workspace arbitraire).
 *   - `status` / `consumed_at` : usage unique. Un jeton consommé ne peut plus
 *     ouvrir de session, même s'il est encore dans sa fenêtre de validité.
 *   - `expires_at` : TTL court (quelques minutes). C'est la défense principale,
 *     celle qui tient même si l'usage unique est contourné.
 *
 * ORDER BY (token_hash) : le seul accès est la recherche par hash au moment de
 * la consommation. ReplacingMergeTree(updated_at) pour que la ré-insertion
 * marquant la consommation remplace la ligne d'origine.
 *
 * ⚠️ Limite ClickHouse assumée et documentée (cf. sso.service.ts) : il n'existe
 * pas de compare-and-swap. La consommation est un read-then-write, qui ferme le
 * rejeu SÉQUENTIEL (le cas réel : un jeton retrouvé plus tard dans un historique
 * ou un log) mais pas une course strictement simultanée. Le TTL court et le fait
 * que le jeton ne transite qu'en fragment d'URL sont les garde-fous qui tiennent
 * dans tous les cas.
 *
 * Les fresh installs obtiennent la table via SYSTEM_SCHEMAS (`database/schemas.ts`) ;
 * cette migration couvre le chemin d'upgrade des installs déjà en version 12.
 */
export const V13SsoTokensMigration: MajorMigration = {
  majorVersion: 13,

  hasSystemMigration(): boolean {
    return true;
  },

  hasWorkspaceMigration(): boolean {
    return false;
  },

  async migrateSystem(
    client: ClickHouseClient,
    systemDb: string,
  ): Promise<void> {
    console.log('[V13 Migration] Creating sso_login_tokens table...');
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${systemDb}.sso_login_tokens (
          id String,
          token_hash String,
          user_id String,
          workspace_id String DEFAULT '',
          status Enum8('pending' = 1, 'used' = 2) DEFAULT 'pending',
          issued_to_hub_user_id String DEFAULT '',
          expires_at DateTime64(3),
          consumed_at Nullable(DateTime64(3)),
          consumed_ip String DEFAULT '',
          created_at DateTime64(3) DEFAULT now64(3),
          updated_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY token_hash
      `,
    });

    console.log('[V13 Migration] sso_login_tokens table created');
  },

  async migrateWorkspace(): Promise<void> {
    // No workspace-level changes
  },
};
