import { ConfigService } from '@nestjs/config';
import { RobotsController } from './robots.controller';

describe('RobotsController', () => {
  let controller: RobotsController;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    configService = { get: jest.fn() };
    controller = new RobotsController(
      configService as unknown as ConfigService,
    );
  });

  describe('robots.txt — demo build (IS_DEMO=true)', () => {
    beforeEach(() => {
      configService.get.mockImplementation((key: string, def?: string) =>
        key === 'IS_DEMO' ? 'true' : def,
      );
    });

    it('keeps the landing indexable but locks dashboards/api/login', () => {
      const body = controller.robots();
      expect(body).toMatch(/User-agent:\s*\*/);
      expect(body).toMatch(/Allow:\s*\/\$/);
      expect(body).toMatch(/Disallow:\s*\/workspaces/);
      expect(body).toMatch(/Disallow:\s*\/api\//);
      expect(body).toMatch(/Disallow:\s*\/login/);
      expect(body).toMatch(/Disallow:\s*\/setup/);
    });

    it('points the sitemap at the demo domain (not cross-domain)', () => {
      const body = controller.robots();
      expect(body).toMatch(
        /Sitemap:\s*https:\/\/demo-analytics\.veridian\.site\/sitemap\.xml/,
      );
    });
  });

  describe('robots.txt — internal / tenant build (IS_DEMO unset)', () => {
    beforeEach(() => {
      configService.get.mockImplementation((_key: string, def?: string) => def);
    });

    it('returns a blanket Disallow: / (no indexing on tenant SaaS)', () => {
      const body = controller.robots();
      expect(body).toMatch(/User-agent:\s*\*/);
      expect(body).toMatch(/Disallow:\s*\//);
      // Crucial: the demo-only sitemap must NOT leak onto a tenant deployment.
      expect(body).not.toContain('demo-analytics.veridian.site');
      // And no per-route allow exception.
      expect(body).not.toMatch(/Allow:\s*\/\$/);
    });
  });
});
