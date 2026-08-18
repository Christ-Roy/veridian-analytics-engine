import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';

/**
 * Le controller SSO ne porte aucune logique métier — mais il porte deux
 * traductions faciles à casser en silence, et c'est ce qu'on teste ici :
 *
 * 1. Le renommage snake_case → camelCase entre le DTO reçu du Hub
 *    (`hub_user_id`, `workspace_id`) et l'entrée du service. Une faute de
 *    frappe ici ne casse aucun typage : le champ arrive simplement à
 *    `undefined`, et `workspace_id` silencieusement perdu ferait retomber
 *    l'émission sur le PREMIER workspace du user au lieu de celui demandé.
 *    C'est-à-dire un jeton scopé sur le mauvais espace client.
 *
 * 2. L'extraction de l'IP depuis `x-forwarded-for`, qui alimente la piste
 *    d'audit. Derrière un reverse-proxy l'en-tête est une LISTE ; ne pas
 *    prendre la première valeur enregistre l'IP du proxy, et l'audit ne vaut
 *    plus rien le jour où on en a besoin.
 */
describe('SsoController', () => {
  function makeHarness() {
    const ssoService = {
      issueToken: jest.fn(async () => ({
        autologin_url: 'https://analytics.example.test/sso#deadbeef',
        expires_in: 120,
      })),
      consume: jest.fn(async () => ({
        access_token: 'jwt-de-test',
        user: {
          id: 'user-1',
          email: 'client@example.com',
          name: 'Client Test',
          is_super_admin: false,
        },
        workspace_id: 'ws-alpha',
      })),
    };

    return {
      ssoService,
      controller: new SsoController(ssoService as unknown as SsoService),
    };
  }

  it("traduit le DTO snake_case du Hub vers l'entrée du service", async () => {
    const { controller, ssoService } = makeHarness();

    await controller.issueToken({
      email: 'client@example.com',
      hub_user_id: '7f3a1c2e-0000-4000-8000-000000000001',
      workspace_id: 'ws-beta',
    });

    expect(ssoService.issueToken).toHaveBeenCalledWith(
      {
        email: 'client@example.com',
        hubUserId: '7f3a1c2e-0000-4000-8000-000000000001',
        workspaceId: 'ws-beta',
      },
      undefined,
    );
  });

  it('retient la PREMIÈRE ip de x-forwarded-for, pas celle du proxy', async () => {
    const { controller, ssoService } = makeHarness();

    await controller.issueToken(
      { email: 'client@example.com' },
      '203.0.113.7, 10.0.0.1, 10.0.0.2',
    );

    expect(ssoService.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'client@example.com' }),
      '203.0.113.7',
    );
  });

  it("laisse remonter l'erreur typée du service sans la réécrire", async () => {
    // Le typage des refus (`user_not_found`, `workspace_mismatch`…) n'a de
    // valeur que s'il arrive intact jusqu'au Hub. Un `try/catch` complaisant
    // ajouté ici plus tard le détruirait sans qu'aucun autre test ne bronche.
    const { controller, ssoService } = makeHarness();
    const refus = Object.assign(new Error('Not Found'), {
      response: { error: 'user_not_found' },
    });
    ssoService.issueToken.mockRejectedValueOnce(refus);

    await expect(
      controller.issueToken({ email: 'personne@example.com' }),
    ).rejects.toBe(refus);
  });

  it("transmet l'ip et le user-agent à la consommation (piste d'audit)", async () => {
    const { controller, ssoService } = makeHarness();

    await controller.exchange(
      { token: 'ff'.repeat(32) },
      '203.0.113.7, 10.0.0.1',
      'Mozilla/5.0 (test)',
    );

    expect(ssoService.consume).toHaveBeenCalledWith(
      'ff'.repeat(32),
      '203.0.113.7',
      'Mozilla/5.0 (test)',
    );
  });
});
