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
      "Demande inexploitable (`identity_required`, `identity_unresolvable`) ou utilisateur sans workspace Analytics (`user_not_in_app`). Le code est dans le champ `error`.",
  })
  @ApiResponse({
    status: 401,
    description:
      'Signature HMAC absente, invalide ou hors fenêtre anti-rejeu. Refus volontairement muet : avant authentification, rien ne filtre.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Compte non actif (`user_not_active`) ou workspace hors du périmètre du user (`workspace_mismatch`).',
  })
  @ApiResponse({
    status: 404,
    description: 'Aucun compte Analytics pour cet email (`user_not_found`).',
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
