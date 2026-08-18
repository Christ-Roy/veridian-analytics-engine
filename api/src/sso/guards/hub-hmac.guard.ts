import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Guard HMAC pour les routes appelées par le Hub Veridian.
 *
 * Ce guard protège l'émission de jetons SSO — c'est-à-dire le pouvoir d'ouvrir
 * une session cliente sans mot de passe. C'est le point le plus sensible de
 * l'app : quiconque passe ce guard peut entrer dans l'espace de n'importe quel
 * client. Il est donc volontairement plus strict que `PlatformAdminGuard`.
 *
 * Pourquoi HMAC et pas un simple Bearer comme les autres routes plateforme :
 * un Bearer prouve seulement que l'appelant connaît un secret. Une signature
 * HMAC lie en plus la requête à SON CORPS et à SON INSTANT. Concrètement, un
 * Bearer intercepté peut être rejoué indéfiniment avec n'importe quel corps
 * (donc pour n'importe quel client) ; une signature interceptée ne vaut que
 * pour le corps exact signé, et seulement pendant 5 minutes.
 *
 * Format de signature — celui DÉJÀ en vigueur côté bridge Veridian
 * (`veridian-bridge/src/hub-hmac.ts`), délibérément non réinventé pour ne pas
 * créer un second dialecte HMAC dans la même application :
 *   - `X-Veridian-Timestamp`      : horloge du Hub, en millisecondes unix
 *   - `X-Veridian-Hub-Signature`  : hex(HMAC-SHA256(secret, "{timestamp}.{raw_body}"))
 *
 * Secret : `HUB_HMAC_SECRET` côté engine — même valeur que ce que le Hub
 * nomme `ANALYTICS_HUB_API_SECRET` de son côté. Les deux noms désignent le même
 * secret partagé ; c'est une divergence de convention entre repos, pas deux
 * secrets. Les deux noms sont acceptés en lecture pour que l'app démarre quelle
 * que soit la convention utilisée au déploiement.
 *
 * Fail-closed : sans secret configuré, TOUTES les requêtes sont refusées. Un
 * SSO qui s'ouvrirait « parce que la variable manque » serait une porte
 * d'entrée, pas une commodité.
 */
@Injectable()
export class HubHmacGuard implements CanActivate {
  private readonly logger = new Logger(HubHmacGuard.name);

  /** Fenêtre anti-rejeu. Alignée sur le bridge. */
  private static readonly MAX_DRIFT_MS = 5 * 60 * 1000;

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();

    const secret = this.resolveSecret();
    if (!secret) {
      // On log pour qu'un opérateur voie la mauvaise configuration, mais on ne
      // dit rien de plus au client que « non autorisé ».
      this.logger.warn(
        'HUB_HMAC_SECRET (alias ANALYTICS_HUB_API_SECRET) non configuré — toutes les requêtes SSO seront rejetées',
      );
      throw new UnauthorizedException('SSO endpoint not configured');
    }

    const timestampHeader = this.headerOf(request, 'x-veridian-timestamp');
    const signatureHeader = this.headerOf(request, 'x-veridian-hub-signature');

    if (!timestampHeader || !signatureHeader) {
      throw new UnauthorizedException('Missing signature headers');
    }

    const timestamp = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Anti-rejeu. Volontairement bilatéral (Math.abs) : une signature datée
    // dans le FUTUR est tout aussi suspecte qu'une signature périmée — elle
    // trahit soit une horloge cassée, soit une tentative de fabriquer un jeton
    // à durée de vie prolongée.
    if (Math.abs(Date.now() - timestamp) > HubHmacGuard.MAX_DRIFT_MS) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Les octets EXACTS reçus. `rawBody` est peuplé par `rawBody: true`
    // (main.ts). S'il est absent, on refuse plutôt que de retomber sur un
    // JSON.stringify(req.body) : re-sérialiser côté serveur produirait une
    // signature différente de celle du Hub au moindre écart de formatage, et
    // le « correctif » naturel serait d'affaiblir la vérification.
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      this.logger.error(
        'req.rawBody absent — `rawBody: true` manque au bootstrap NestJS. Vérification HMAC impossible.',
      );
      throw new UnauthorizedException('Invalid signature');
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`, 'utf8')
      .digest('hex');

    if (!this.timingSafeStringEqual(signatureHeader, expected)) {
      throw new UnauthorizedException('Invalid signature');
    }

    return true;
  }

  /**
   * Lit le secret partagé. `HUB_HMAC_SECRET` est le nom canonique côté engine
   * et bridge ; `ANALYTICS_HUB_API_SECRET` est le nom que le Hub emploie pour
   * la même valeur. On lit aussi bien via ConfigService que via process.env,
   * pour les mêmes raisons que PlatformAdminGuard (snapshot ConfigModule en
   * test, variable injectée tardivement au déploiement).
   */
  private resolveSecret(): string {
    const candidates = [
      this.configService.get<string>('HUB_HMAC_SECRET'),
      process.env.HUB_HMAC_SECRET,
      this.configService.get<string>('ANALYTICS_HUB_API_SECRET'),
      process.env.ANALYTICS_HUB_API_SECRET,
    ];
    return candidates.find((v) => typeof v === 'string' && v.length > 0) ?? '';
  }

  private headerOf(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  /**
   * Comparaison à temps constant. `timingSafeEqual` exige des buffers de même
   * longueur et lève sinon — comparer les longueurs d'abord fuiterait la
   * longueur attendue. On normalise donc sur la longueur attendue et on
   * combine les deux verdicts sans court-circuit.
   */
  private timingSafeStringEqual(presented: string, expected: string): boolean {
    const presentedBuf = Buffer.from(presented, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    const padded = Buffer.alloc(expectedBuf.length);
    presentedBuf.copy(
      padded,
      0,
      0,
      Math.min(presentedBuf.length, expectedBuf.length),
    );

    const lengthsMatch = presentedBuf.length === expectedBuf.length;
    const contentsMatch = timingSafeEqual(padded, expectedBuf);
    return lengthsMatch && contentsMatch;
  }
}
