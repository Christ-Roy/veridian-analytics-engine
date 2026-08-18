import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { AuthThrottle } from '../common/decorators/throttle.decorator';
import { HubHmacGuard } from './guards/hub-hmac.guard';
import { SsoService } from './sso.service';
import { ExchangeTokenDto, IssueTokenDto } from './dto/issue-token.dto';

/**
 * Couche SSO : permet au Hub d'ouvrir une session Analytics pour un client
 * sans qu'il ait à se reconnecter.
 *
 * Le flux complet, en trois temps :
 *   1. Le client clique « Ouvrir Analytics » dans le Hub.
 *   2. Le Hub appelle `sso.issueToken` (signé HMAC) et reçoit une
 *      `autologin_url` de la forme `https://<app>/sso#<token>`, vers laquelle
 *      il redirige le navigateur.
 *   3. La page console `/sso` lit le jeton dans le fragment, l'échange contre
 *      un JWT via `sso.exchange`, et le client atterrit dans son espace.
 *
 * Pourquoi un échange en deux temps plutôt qu'un simple `GET /auth/token?t=`
 * qui poserait un cookie — la solution que décrivait le ticket d'origine :
 *   - l'authentification de la console est en **localStorage**, pas en cookie.
 *     Une route qui pose un cookie de session ne connecte donc personne ; il
 *     faut de toute façon remettre un JWT à du code qui tourne dans la page.
 *   - le jeton dans un **fragment** n'atteint jamais le serveur, là où un `?t=`
 *     se serait retrouvé dans les logs d'accès et dans l'en-tête `Referer`.
 */
@ApiTags('sso')
@Controller('api')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  /**
   * Émission — réservée au Hub, authentifiée par signature HMAC.
   *
   * `@Public()` retire le JWT guard global : l'authentification de cette route
   * est portée par `HubHmacGuard`, pas par une session utilisateur. Le Hub est
   * une machine, il n'a pas de session.
   */
  @Post('sso.issueToken')
  @HttpCode(200)
  @Public()
  @UseGuards(HubHmacGuard)
  @ApiOperation({
    summary: "Émet un jeton d'autologin à usage unique (appelé par le Hub)",
  })
  @ApiResponse({
    status: 200,
    description: 'Jeton émis',
    schema: {
      properties: {
        autologin_url: { type: 'string' },
        expires_in: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      "Code métier dans le champ `error`, précision dans `hint`. `user_not_in_app` : aucun compte Analytics pour cet email, OU compte sans workspace — c'est le seul cas sur lequel le Hub sait agir (il propose l'inscription). `user_not_active` : compte suspendu. `identity_required` / `identity_unresolvable` : demande inexploitable.",
  })
  @ApiResponse({
    status: 401,
    description:
      'Signature HMAC absente, invalide ou hors fenêtre anti-rejeu. Refus volontairement muet : avant authentification, rien ne filtre.',
  })
  @ApiResponse({
    status: 403,
    description:
      "Workspace hors du périmètre du user (`workspace_mismatch`). Injoignable depuis le Hub actuel, qui n'envoie pas `workspace_id`.",
  })
  async issueToken(
    @Body() dto: IssueTokenDto,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    const ipAddress = forwardedFor?.split(',')[0].trim();
    return this.ssoService.issueToken(
      {
        email: dto.email,
        hubUserId: dto.hub_user_id,
        workspaceId: dto.workspace_id,
      },
      ipAddress,
    );
  }

  /**
   * Même chose, sous le nom et la forme que le Hub appelle réellement.
   *
   * ── Pourquoi cette route existe EN PLUS de `sso.issueToken` ──────────────
   *
   * Le Hub est l'orchestrateur de la plateforme : il pilote toutes les apps en
   * aval selon un motif uniforme (`POST <app>/api/sso/issue-magic-link`
   * → `{ magic_link_url }`), déjà en service pour Notifuse et Prospection.
   * C'est donc l'engine qui s'aligne, pas le contraire — sinon chaque app
   * imposerait son dialecte au seul composant censé les unifier.
   *
   * Avant cette route, le client Hub (`lib/auth/bounce-apps.ts`) appelait ce
   * chemin, prenait un 404, et le traduisait en « app injoignable ». Le SSO
   * autologin Hub → Analytics ne fonctionnait donc pas — et l'échec ressemblait
   * à une panne d'infrastructure, ce qui est la pire façon d'échouer : on
   * cherche du côté du réseau un problème de contrat.
   *
   * ── Additive, jamais substitutive ────────────────────────────────────────
   *
   * `sso.issueToken` reste en place et inchangée. Elle est utilisée par les
   * tests E2E existants et potentiellement par des appelants qu'on ne connaît
   * pas ; la remplacer aurait échangé une panne contre une autre. Les deux
   * routes partagent la même logique, le même guard et le même jeton : seule
   * la CLÉ de la réponse diffère (`magic_link_url` vs `autologin_url`), parce
   * que c'est celle que le Hub sait lire.
   *
   * ── Sur la durée de vie du jeton ─────────────────────────────────────────
   *
   * Le contrat Hub suggère « TTL court (≈15 min) ». On garde volontairement
   * les 2 minutes de `sso.issueToken` : le Hub redirige le navigateur
   * IMMÉDIATEMENT sur l'URL rendue, il ne l'envoie jamais par email. Le seul
   * délai légitime est un aller-retour réseau ; 15 minutes n'ajouteraient
   * aucun confort et élargiraient d'autant la fenêtre d'un jeton fuité.
   */
  @Post('sso/issue-magic-link')
  @HttpCode(200)
  @Public()
  @UseGuards(HubHmacGuard)
  @ApiOperation({
    summary:
      "Émet un lien de session à usage unique — forme attendue par le Hub",
  })
  @ApiResponse({
    status: 200,
    description: 'Lien émis',
    schema: { properties: { magic_link_url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 400,
    description:
      'Mêmes codes que `sso.issueToken` : `user_not_in_app`, `user_not_active`, `identity_required`, `identity_unresolvable`. Code dans le champ `error`.',
  })
  @ApiResponse({ status: 401, description: 'Signature HMAC invalide.' })
  @ApiResponse({
    status: 403,
    description: 'Workspace hors du périmètre du user (`workspace_mismatch`).',
  })
  async issueMagicLink(
    @Body() dto: IssueTokenDto,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ): Promise<{ magic_link_url: string }> {
    const ipAddress = forwardedFor?.split(',')[0].trim();
    const result = await this.ssoService.issueToken(
      {
        email: dto.email,
        hubUserId: dto.hub_user_id,
        workspaceId: dto.workspace_id,
      },
      ipAddress,
    );
    return { magic_link_url: result.autologin_url };
  }

  /**
   * Consommation — publique, appelée par la page console `/sso`.
   *
   * Publique par nécessité : l'appelant n'est justement pas encore connecté.
   * Ce qui la protège n'est donc pas un guard mais la nature du jeton lui-même
   * (32 octets aléatoires, usage unique, 2 minutes de validité), plus le
   * throttle strict ci-dessous qui rend le tirage au sort inexploitable.
   */
  @Post('sso.exchange')
  @HttpCode(200)
  @Public()
  @AuthThrottle()
  @ApiOperation({
    summary: "Échange un jeton d'autologin contre une session",
  })
  @ApiResponse({ status: 200, description: 'Session ouverte' })
  @ApiResponse({
    status: 401,
    description:
      'Jeton inconnu, expiré ou déjà consommé — indistinguables volontairement.',
  })
  async exchange(
    @Body() dto: ExchangeTokenDto,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ipAddress = forwardedFor?.split(',')[0].trim();
    return this.ssoService.consume(dto.token, ipAddress, userAgent);
  }
}
