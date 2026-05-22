import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

describe('DemoController', () => {
  let controller: DemoController;
  let demoService: jest.Mocked<Pick<DemoService, 'findDemoUser'>>;
  let configService: { get: jest.Mock };
  let jwtService: { sign: jest.Mock };

  beforeEach(() => {
    demoService = {
      findDemoUser: jest.fn(),
    };
    configService = { get: jest.fn() };
    jwtService = { sign: jest.fn() };

    controller = new DemoController(
      demoService as unknown as DemoService,
      configService as unknown as ConfigService,
      jwtService as unknown as JwtService,
    );
  });

  describe('publicConfig', () => {
    it('reports is_demo=true when IS_DEMO=true', () => {
      configService.get.mockReturnValue('true');
      const cfg = controller.publicConfig();
      expect(cfg.is_demo).toBe(true);
      expect(cfg.demo_workspace_id).toBe('demo-apple');
      expect(cfg.contact_email).toBe('robert.brunon@veridian.site');
    });

    it('reports is_demo=false when IS_DEMO unset (default)', () => {
      configService.get.mockImplementation((_key: string, def: string) => def);
      expect(controller.publicConfig().is_demo).toBe(false);
    });
  });

  describe('login', () => {
    it('rejects with 403 when not in demo mode', async () => {
      configService.get.mockImplementation((_key: string, def: string) => def);
      await expect(controller.login()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(demoService.findDemoUser).not.toHaveBeenCalled();
    });

    it('returns 503 when demo data is not yet seeded', async () => {
      configService.get.mockReturnValue('true');
      demoService.findDemoUser.mockResolvedValue(null);
      await expect(controller.login()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('mints a JWT for the demo user when seeded', async () => {
      configService.get.mockReturnValue('true');
      demoService.findDemoUser.mockResolvedValue({
        id: 'user-123',
        email: 'demo@veridian.site',
        name: 'Visiteur Démo',
      });
      jwtService.sign.mockReturnValue('signed.jwt.token');

      const res = await controller.login();

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-123',
          email: 'demo@veridian.site',
          isDemo: true,
        }),
      );
      // No session is persisted for the anonymous demo identity.
      expect(jwtService.sign.mock.calls[0][0]).not.toHaveProperty('sessionId');
      expect(res.access_token).toBe('signed.jwt.token');
      expect(res.user).toEqual({
        id: 'user-123',
        email: 'demo@veridian.site',
        name: 'Visiteur Démo',
        is_super_admin: false,
      });
    });
  });
});
