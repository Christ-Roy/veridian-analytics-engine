import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouseService } from '../database/clickhouse.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { generateId, generateToken, hashToken } from '../common/crypto';
import {
  toClickHouseDateTime,
  parseClickHouseDateTime,
} from '../common/utils/datetime.util';

/**
 * Durée de vie d'un jeton d'autologin.
 *
 * 2 minutes, pas 5 : un jeton SSO n'est pas fait pour être stocké ni transmis,
 * il est consommé par une redirection immédiate du navigateur après un clic
 * dans le Hub. Le seul délai légitime entre l'émission et la consommation est
 * un aller-retour réseau. Toute durée plus longue n'ajoute aucun confort pour
 * l'utilisateur et n'élargit que la fenêtre d'exploitation d'un jeton fuité.
 */
const SSO_TOKEN_TTL_MS = 2 * 60 * 1000;

export interface SsoTokenRow {
  id: string;
  token_hash: string;
  user_id: string;
  workspace_id: string;
  status: 'pending' | 'used';
  issued_to_hub_user_id: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_ip: string;
  created_at: string;
  updated_at: string;
}

export interface IssueTokenInput {
  email?: string;
  hubUserId?: string;
  workspaceId?: string;
}

export interface IssueTokenResult {
  autologin_url: string;
  expires_in: number;
}

export interface ConsumeTokenResult {
  access_token: string;
  user: {
    id: string;
    email: string;
    name: string;
    is_super_admin: boolean;
  };
  workspace_id: string | null;
}

/**
 * Émission et consommation des jetons d'autologin SSO.
 *
 * Le Hub, qui a déjà authentifié le client chez lui, demande ici un jeton
 * à usage unique et très court, puis redirige le navigateur du client vers
 * l'URL retournée. Le client atterrit connecté dans son espace Analytics.
 *
 * ── Ce que ce mécanisme protège, et comment ──────────────────────────────
 *
 * 1. **Fuite du jeton par l'URL.** C'est la faiblesse classique de ce genre de
 *    flux, et la raison pour laquelle l'URL retournée place le jeton dans un
 *    FRAGMENT (`/sso#<token>`) et non dans une query string (`?t=<token>`).
 *    Un fragment n'est jamais envoyé au serveur : il n'apparaît ni dans les
 *    logs d'accès, ni dans les traces du reverse-proxy, ni dans l'en-tête
 *    `Referer` des requêtes que la page émet ensuite. Avec `?t=`, le jeton
 *    aurait fuité dans les journaux des DEUX côtés à chaque redirection.
 *
 * 2. **Rejeu.** Usage unique (`status`/`consumed_at`) + TTL de 2 minutes.
 *    Voir la limite ClickHouse documentée sur `consume()`.
 *
 * 3. **Fuite entre tenants.** Le jeton est lié à un `workspace_id` À
 *    L'ÉMISSION, et l'appartenance du user à ce workspace est vérifiée à ce
 *    moment-là. Un jeton ne peut donc pas servir à entrer dans le workspace
 *    d'un autre client, même si le Hub se trompe de cible plus tard.
 *
 * 4. **Énumération d'adresses email.** Elle est bloquée par le guard, pas par
 *    l'opacité des messages : sans signature HMAC valide, on n'atteint jamais
 *    la logique d'émission. Les refus de `issueToken` sont donc typés et
 *    distincts, délibérément — détail et raisonnement sur la méthode.
 *
 * ── Ce que ce mécanisme ne protège PAS ───────────────────────────────────
 *
 * Quiconque détient le secret HMAC peut se faire ouvrir la session de
 * n'importe quel client. Ce secret a exactement la valeur d'un mot de passe
 * maître : il ne doit jamais quitter le Hub et le coffre de credentials.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Émet un jeton d'autologin pour un utilisateur.
   *
   * ── Sur le détail des erreurs ────────────────────────────────────────────
   *
   * Cette route renvoie des codes d'erreur DISTINCTS et actionnables, et non
   * un 401 opaque. Ce n'est pas un relâchement : la route est derrière
   * `HubHmacGuard`, donc un appelant qui atteint cette méthode détient déjà le
   * secret partagé — c'est-à-dire le pouvoir d'ouvrir la session de n'importe
   * quel client. Lui cacher qu'un email est inconnu ne le freine en rien ;
   * l'anti-énumération sur une route à secret maître ne protège personne.
   *
   * En revanche, le coût de l'opacité est réel : le Hub doit savoir DISTINGUER
   * « ce client n'a pas de compte Analytics » (afficher autre chose qu'un lien
   * cassé) de « mon workspace en base est périmé » (resynchroniser). Un 401
   * unique le laisse sans recours face à l'utilisateur.
   *
   * Le seul refus volontairement muet reste celui du guard : avant
   * authentification, rien ne filtre.
   *
   * ── Forme de l'erreur ────────────────────────────────────────────────────
   *
   * Le code part dans un champ `error`, PAS `error_code` : c'est celui que le
   * client Analytics du Hub lit (`lib/analytics/client.ts`, extraction de
   * `body.error`). Avec `error_code`, le Hub n'aurait vu qu'un « HTTP 400 » et
   * tout ce travail de typage n'aurait servi à rien.
   *
   * ── Les statuts HTTP sont calés sur le CLIENT RÉEL, pas sur le ticket ────
   *
   * Le consommateur est `veridian-hub/lib/auth/bounce-apps.ts`. Lu, et non
   * supposé — le ticket décrit une intention à une date, le client décrit ce
   * qui arrivera vraiment à l'utilisateur. Ce que ce client fait des statuts :
   *
   *   400 + `error: "user_not_in_app"` → SEUL cas actionnable. Le Hub redirige
   *                                      vers `/dashboard?app=…&hint=signup`.
   *   400 + tout autre code            → `unreachable`, code conservé au log.
   *   401 ou 403                       → `unreachable`, libellé « secret
   *                                      désync ? ». Alarme d'infra.
   *   404 / 405 / 501                  → `unreachable`, « not implemented ».
   *
   * D'où deux choix qui contredisent la lettre du ticket, délibérément :
   *
   * - Un email sans compte renvoie **400 `user_not_in_app`**, pas 404. Un 404
   *   serait lu comme « la route n'existe pas » et rendrait un client inconnu
   *   indiscernable d'un engine pas déployé — pire que le 401 d'origine. Le
   *   cas « pas de compte » et le cas « compte sans workspace » partagent donc
   *   le même code : c'est correct, le Hub ne peut de toute façon en faire
   *   qu'une seule chose (proposer l'inscription). La distinction reste dans
   *   `hint` et dans les logs, pour nous.
   *
   * - Un compte suspendu renvoie **400 `user_not_active`**, pas 403. Un 403
   *   déclencherait une alerte « secret désync » chez le Hub : on ferait
   *   chercher un problème HMAC pour un compte simplement désactivé.
   *
   * `workspace_mismatch` reste en **403** : le statut est juste, il colle au
   * ticket, et le client actuel n'envoie jamais `workspace_id` — ce chemin est
   * donc injoignable depuis le Hub d'aujourd'hui. Si le Hub se met à le
   * fournir, il faudra qu'il cesse de confondre 403 et secret désync.
   *
   * ⚠️ DEUX ÉCARTS OUVERTS, hors périmètre de ce correctif :
   *   1. Le Hub appelle `POST /api/sso/issue-magic-link` et attend
   *      `{ magic_link_url }` ; l'engine expose `POST /api/sso.issueToken` et
   *      renvoie `{ autologin_url, expires_in }`. Route ET forme divergent :
   *      aujourd'hui le Hub prend un 404 et conclut « app injoignable ».
   *   2. Le ticket prévoit un 409 `workspace_required` avec la liste des
   *      workspaces quand `workspace_id` est absent ; l'engine retombe sur le
   *      premier workspace du user.
   */
  async issueToken(
    input: IssueTokenInput,
    ipAddress?: string,
  ): Promise<IssueTokenResult> {
    if (!input.email && !input.hubUserId) {
      throw new BadRequestException({
        error: 'identity_required',
        message: 'email ou hub_user_id requis',
      });
    }

    // Résolution par email. `hub_user_id` seul n'est pas encore une clé de
    // résolution : l'engine ne stocke aucune correspondance vers les
    // identifiants Hub. On le conserve pour l'audit, et il deviendra une clé
    // le jour où le Hub écrira cette correspondance au provisioning.
    if (!input.email) {
      this.logger.warn(
        'issueToken appelé avec hub_user_id seul — non résoluble côté engine (aucune correspondance stockée)',
      );
      throw new BadRequestException({
        error: 'identity_unresolvable',
        message:
          "hub_user_id seul n'est pas résoluble côté engine — fournir email",
      });
    }

    const user = await this.usersService.findByEmail(input.email);
    if (!user) {
      this.logger.log(
        `SSO refusé : aucun compte pour l'email demandé (hub_user_id=${input.hubUserId ?? 'n/a'})`,
      );
      throw new BadRequestException({
        error: 'user_not_in_app',
        hint: 'no analytics account for this email',
        message: 'Aucun compte Analytics pour cet email',
      });
    }

    // Un compte suspendu ou supprimé ne doit pas pouvoir être rouvert par le
    // Hub. Sans ce contrôle, le SSO deviendrait un contournement silencieux de
    // la désactivation de compte.
    if (user.status !== 'active') {
      this.logger.warn(
        `SSO refusé : compte non actif (user_id=${user.id}, status=${user.status})`,
      );
      throw new BadRequestException({
        error: 'user_not_active',
        hint: 'analytics account exists but is not active',
        message: 'Compte Analytics inactif',
      });
    }

    const workspaceId = await this.resolveWorkspace(user.id, input.workspaceId);

    const { token, hash } = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SSO_TOKEN_TTL_MS);

    await this.clickhouse.insertSystem('sso_login_tokens', [
      {
        id: generateId(),
        token_hash: hash,
        user_id: user.id,
        workspace_id: workspaceId,
        status: 'pending',
        issued_to_hub_user_id: input.hubUserId ?? '',
        expires_at: toClickHouseDateTime(expiresAt),
        consumed_at: null,
        consumed_ip: '',
        created_at: toClickHouseDateTime(now),
        updated_at: toClickHouseDateTime(now),
      },
    ]);

    await this.auditService.log({
      user_id: user.id,
      workspace_id: workspaceId,
      action: 'sso.token_issued',
      target_type: 'user',
      target_id: user.id,
      metadata: { hub_user_id: input.hubUserId ?? null },
      ip_address: ipAddress,
      user_agent: undefined,
    });

    return {
      autologin_url: this.buildAutologinUrl(token),
      expires_in: Math.floor(SSO_TOKEN_TTL_MS / 1000),
    };
  }

  /**
   * Consomme un jeton d'autologin et ouvre une session.
   *
   * ⚠️ Limite assumée, à ne pas maquiller : ClickHouse n'offre pas de
   * compare-and-swap. La consommation est donc un read-then-write. Cela ferme
   * le rejeu SÉQUENTIEL — le cas réellement exploitable, où un jeton est
   * retrouvé plus tard dans un historique de navigation, un signet ou un log
   * et rejoué. Cela ne ferme pas une course strictement simultanée, où deux
   * requêtes liraient l'état « pending » avant que l'une n'ait écrit.
   *
   * Ce qui rend ce résidu acceptable : la fenêtre de course se compte en
   * millisecondes, l'attaquant devrait déjà détenir le jeton, et les deux
   * sessions obtenues appartiendraient de toute façon au MÊME utilisateur —
   * il n'y a aucun gain de privilège à la clé. Les défenses qui tiennent dans
   * tous les cas restent le TTL de 2 minutes et le fait que le jeton ne
   * transite qu'en fragment d'URL.
   *
   * Si un jour ce résidu devient inacceptable, le correctif propre n'est pas
   * de bricoler un verrou : c'est de déplacer cette table hors de ClickHouse,
   * vers un store offrant une écriture conditionnelle.
   */
  async consume(
    rawToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ConsumeTokenResult> {
    // Message unique pour tous les refus : un jeton inconnu, expiré ou déjà
    // consommé doivent être indiscernables, sinon la route devient un oracle
    // permettant de tester la validité de jetons à l'aveugle.
    const invalid = () =>
      new UnauthorizedException('Invalid or expired SSO token');

    if (!rawToken || rawToken.length === 0) {
      throw invalid();
    }

    const tokenHash = hashToken(rawToken);

    const rows = await this.clickhouse.querySystem<SsoTokenRow>(
      `
      SELECT * FROM sso_login_tokens FINAL
      WHERE token_hash = {tokenHash:String}
      LIMIT 1
    `,
      { tokenHash },
    );

    const row = rows[0];
    if (!row) {
      throw invalid();
    }

    if (row.status !== 'pending' || row.consumed_at !== null) {
      // Un jeton rejoué est un signal : soit un double-clic anodin, soit
      // quelqu'un qui exploite un jeton ramassé quelque part. On le trace au
      // niveau warning pour qu'il soit visible dans les logs.
      this.logger.warn(
        `Jeton SSO déjà consommé, rejeu refusé (user_id=${row.user_id})`,
      );
      throw invalid();
    }

    if (parseClickHouseDateTime(row.expires_at) < new Date()) {
      throw invalid();
    }

    const user = await this.usersService.findById(row.user_id);
    if (!user) {
      throw invalid();
    }

    // Re-contrôle du statut AU MOMENT DE LA CONSOMMATION, pas seulement à
    // l'émission. Un compte peut avoir été suspendu dans l'intervalle : la
    // vérification faite à l'émission ne vaut plus rien ici.
    if (user.status !== 'active') {
      this.logger.warn(
        `Consommation SSO refusée : compte devenu non actif depuis l'émission (user_id=${user.id})`,
      );
      throw invalid();
    }

    // Marque consommé AVANT d'émettre la session : si l'ouverture de session
    // échoue ensuite, le jeton est brûlé plutôt que réutilisable. On préfère
    // un client qui reclique dans le Hub à un jeton qui survit à une erreur.
    const now = toClickHouseDateTime();
    await this.clickhouse.insertSystem('sso_login_tokens', [
      {
        ...row,
        status: 'used',
        consumed_at: now,
        consumed_ip: ipAddress ?? '',
        updated_at: now,
      },
    ]);

    const session = await this.authService.issueSessionForUser(
      user.id,
      user.email,
      ipAddress,
      userAgent,
    );

    await this.auditService.log({
      user_id: user.id,
      workspace_id: row.workspace_id || undefined,
      action: 'sso.token_consumed',
      target_type: 'user',
      target_id: user.id,
      metadata: { session_id: session.session_id },
      ip_address: ipAddress,
      user_agent: undefined,
    });

    return {
      access_token: session.access_token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_super_admin: user.is_super_admin,
      },
      workspace_id: row.workspace_id || null,
    };
  }

  /**
   * Construit l'URL d'atterrissage.
   *
   * Le jeton est placé dans le FRAGMENT (`#`), jamais dans la query string.
   * Un fragment n'est pas transmis au serveur par le navigateur : il n'entre
   * ni dans les logs d'accès de l'engine, ni dans ceux du reverse-proxy, ni
   * dans l'en-tête `Referer` des requêtes suivantes. C'est la différence entre
   * un secret qui vit deux minutes en mémoire du navigateur et un secret
   * archivé en clair dans des journaux conservés des mois.
   */
  private buildAutologinUrl(token: string): string {
    const baseUrl = (
      this.configService.get<string>('APP_URL') ?? 'http://localhost:5173'
    ).replace(/\/+$/, '');
    return `${baseUrl}/sso#${token}`;
  }

  /**
   * Détermine le workspace auquel le jeton sera lié — et refuse plutôt que de
   * deviner.
   *
   * C'est LE contrôle qui empêche un jeton d'ouvrir l'espace d'un autre
   * client. Si le Hub nomme un workspace, on VÉRIFIE l'appartenance du user
   * avant de scoper le jeton dessus ; on ne fait jamais confiance à la cible
   * annoncée par l'appelant, même authentifié. Sinon, on retombe sur le
   * premier workspace du user — jamais sur un workspace arbitraire.
   */
  private async resolveWorkspace(
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<string> {
    if (requestedWorkspaceId) {
      const isMember = await this.isWorkspaceMember(
        userId,
        requestedWorkspaceId,
      );
      if (!isMember) {
        this.logger.warn(
          `SSO refusé : workspace demandé hors périmètre du user (user_id=${userId}, workspace_id=${requestedWorkspaceId})`,
        );
        throw new ForbiddenException({
          error: 'workspace_mismatch',
          message: "L'utilisateur n'a pas accès à ce workspace",
        });
      }
      return requestedWorkspaceId;
    }

    const first = await this.getFirstWorkspaceForUser(userId);
    if (!first) {
      // Un user sans workspace n'a nulle part où atterrir. Émettre un jeton le
      // déposerait sur une console vide ; autant refuser franchement, et le
      // dire assez précisément pour que le Hub propose l'activation plutôt
      // qu'une erreur brute.
      this.logger.warn(`SSO refusé : user sans workspace (user_id=${userId})`);
      throw new BadRequestException({
        error: 'user_not_in_app',
        hint: 'account exists but has no analytics workspace',
        message: 'Aucun workspace Analytics pour cet utilisateur',
      });
    }
    return first;
  }

  private async isWorkspaceMember(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const rows = await this.clickhouse.querySystem<{ count: number }>(
      `
      SELECT count() as count FROM workspace_memberships FINAL
      WHERE user_id = {userId:String}
        AND workspace_id = {workspaceId:String}
    `,
      { userId, workspaceId },
    );
    return (rows[0]?.count ?? 0) > 0;
  }

  private async getFirstWorkspaceForUser(
    userId: string,
  ): Promise<string | null> {
    const rows = await this.clickhouse.querySystem<{ workspace_id: string }>(
      `
      SELECT workspace_id FROM workspace_memberships FINAL
      WHERE user_id = {userId:String}
      ORDER BY workspace_id
      LIMIT 1
    `,
      { userId },
    );
    return rows[0]?.workspace_id || null;
  }
}
