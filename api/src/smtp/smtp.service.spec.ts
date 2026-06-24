import { ConfigService } from '@nestjs/config';
import { SmtpService } from './smtp.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

/**
 * Garde de branding : la config SMTP globale par défaut (quand aucune ENV
 * SMTP_FROM_* n'est posée) doit porter la marque Veridian, JAMAIS Staminads.
 * Un email client brandé Staminads = fuite de la marque upstream.
 */
describe('SmtpService — branding defaults', () => {
  let service: SmtpService;

  /** ConfigService qui renvoie les vraies valeurs si la clé est posée, sinon
   *  le défaut passé en 2e argument (comportement réel de NestJS get). */
  function makeService(env: Record<string, string | undefined>): SmtpService {
    return new SmtpService(
      {
        get: <T>(key: string, def?: T): T | undefined =>
          (env[key] as unknown as T) ?? def,
      } as unknown as ConfigService,
      {
        // Workspace sans SMTP configuré → on retombe sur la config globale.
        get: jest.fn().mockResolvedValue({ id: 'ws-1', settings: {} }),
      } as unknown as WorkspacesService,
    );
  }

  it('defaults the global FROM name/email to Veridian (never Staminads)', async () => {
    // SMTP_HOST posé pour ne pas retourner null ; pas de SMTP_FROM_* → défauts.
    service = makeService({ SMTP_HOST: 'smtp.example.com' });

    const config = await service.getConfig('ws-1');

    expect(config).not.toBeNull();
    expect(config!.from.name).toBe('Veridian Analytics');
    expect(config!.from.email).toBe('noreply@veridian.site');
    expect(config!.from.name).not.toMatch(/staminads/i);
    expect(config!.from.email).not.toMatch(/staminads/i);
  });

  it('honors explicit SMTP_FROM_* overrides', async () => {
    service = makeService({
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM_NAME: 'Acme Reports',
      SMTP_FROM_EMAIL: 'reports@acme.test',
    });

    const config = await service.getConfig('ws-1');

    expect(config!.from.name).toBe('Acme Reports');
    expect(config!.from.email).toBe('reports@acme.test');
  });

  it('returns null when no global SMTP host is configured', async () => {
    service = makeService({});

    const config = await service.getConfig('ws-1');

    expect(config).toBeNull();
  });
});
