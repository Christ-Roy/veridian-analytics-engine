import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { HubHmacGuard } from './hub-hmac.guard';

const SECRET = 'test-hub-secret-at-least-32-characters-long';

function sign(body: string, timestamp: number, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
}

function contextWith(opts: {
  body: string;
  timestamp?: string;
  signature?: string;
  omitRawBody?: boolean;
}): ExecutionContext {
  const headers: Record<string, string> = {};
  if (opts.timestamp !== undefined) {
    headers['x-veridian-timestamp'] = opts.timestamp;
  }
  if (opts.signature !== undefined) {
    headers['x-veridian-hub-signature'] = opts.signature;
  }

  const request = {
    headers,
    rawBody: opts.omitRawBody ? undefined : Buffer.from(opts.body, 'utf8'),
  };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(env: Record<string, string | undefined>): HubHmacGuard {
  const configService = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new HubHmacGuard(configService);
}

describe('HubHmacGuard', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HUB_HMAC_SECRET;
    delete process.env.ANALYTICS_HUB_API_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('accepte une requête correctement signée', () => {
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const body = JSON.stringify({ email: 'client@example.com' });
    const ts = Date.now();

    const ctx = contextWith({
      body,
      timestamp: String(ts),
      signature: sign(body, ts),
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('accepte le secret sous son nom Hub (ANALYTICS_HUB_API_SECRET)', () => {
    // Les deux repos nomment différemment le MÊME secret partagé. L'app doit
    // démarrer quelle que soit la convention employée au déploiement.
    const guard = guardWith({ ANALYTICS_HUB_API_SECRET: SECRET });
    const body = '{}';
    const ts = Date.now();

    const ctx = contextWith({
      body,
      timestamp: String(ts),
      signature: sign(body, ts),
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('refuse tout si aucun secret n\'est configuré (fail-closed)', () => {
    // Le cas le plus dangereux : une variable oubliée au déploiement ne doit
    // jamais ouvrir la route, elle doit la fermer.
    const guard = guardWith({});
    const body = '{}';
    const ts = Date.now();

    const ctx = contextWith({
      body,
      timestamp: String(ts),
      signature: sign(body, ts),
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse une signature produite avec un autre secret', () => {
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const body = '{}';
    const ts = Date.now();

    const ctx = contextWith({
      body,
      timestamp: String(ts),
      signature: sign(body, ts, 'un-tout-autre-secret-de-32-caracteres-min'),
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse quand le corps a été modifié après signature', () => {
    // Le scénario d'attaque concret : un intermédiaire réoriente le jeton vers
    // l'email d'un autre client. La signature couvre le corps, donc ça casse.
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const signedBody = JSON.stringify({ email: 'victime@example.com' });
    const tamperedBody = JSON.stringify({ email: 'attaquant@example.com' });
    const ts = Date.now();

    const ctx = contextWith({
      body: tamperedBody,
      timestamp: String(ts),
      signature: sign(signedBody, ts),
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse une signature rejouée hors de la fenêtre de 5 minutes', () => {
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const body = '{}';
    const staleTs = Date.now() - 6 * 60 * 1000;

    const ctx = contextWith({
      body,
      timestamp: String(staleTs),
      signature: sign(body, staleTs),
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse un timestamp situé dans le futur', () => {
    // Une horodatation future trahit soit une horloge cassée, soit une
    // tentative de fabriquer un jeton à durée de vie prolongée.
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const body = '{}';
    const futureTs = Date.now() + 6 * 60 * 1000;

    const ctx = contextWith({
      body,
      timestamp: String(futureTs),
      signature: sign(body, futureTs),
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse une requête sans en-têtes de signature', () => {
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    expect(() => guard.canActivate(contextWith({ body: '{}' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un timestamp non numérique', () => {
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const ctx = contextWith({
      body: '{}',
      timestamp: 'pas-un-nombre',
      signature: 'peu-importe',
    });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse si rawBody est absent au lieu de retomber sur une re-sérialisation', () => {
    // Garde-fou contre une régression du bootstrap : si `rawBody: true`
    // disparaissait de main.ts, on veut un refus franc, pas une vérification
    // silencieusement affaiblie.
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const body = '{}';
    const ts = Date.now();

    const ctx = contextWith({
      body,
      timestamp: String(ts),
      signature: sign(body, ts),
      omitRawBody: true,
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('vérifie sur les octets bruts, pas sur un JSON re-sérialisé', () => {
    // Corps sémantiquement identique mais formaté différemment : la signature
    // porte sur les octets, donc seule la forme exacte signée doit passer.
    const guard = guardWith({ HUB_HMAC_SECRET: SECRET });
    const spacedBody = '{ "email" : "client@example.com" }';
    const ts = Date.now();

    const ctx = contextWith({
      body: spacedBody,
      timestamp: String(ts),
      signature: sign(spacedBody, ts),
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });
});
