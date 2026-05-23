import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';

/**
 * Dynamic robots.txt — served according to the runtime IS_DEMO flag.
 *
 * BUG-11 — the static `console/public/robots.txt` was written for the
 * demo instance (allow /, disallow /workspaces, sitemap demo-analytics).
 * The same file was being served on `analytics-engine.app.veridian.site`
 * (the real tenant SaaS, behind magic-link from the Hub), accidentally
 * advertising a sitemap pointing at the demo domain and allowing crawlers
 * to index a public admin form (/setup).
 *
 * Resolution: serve robots.txt dynamically. On a demo build (IS_DEMO=true)
 * keep the demo-tuned policy (landing indexable, dashboards not). On any
 * other deployment (the real tenant SaaS, staging consoles), return a
 * blanket `Disallow: /` — this is an authenticated internal application,
 * tenants arrive via magic link from the Hub, not via Google.
 *
 * NOTE: this controller is registered at the application root (not under
 * `/api`) so it intercepts the request before ServeStaticModule serves
 * the on-disk file.
 */
@Controller()
export class RobotsController {
  constructor(private readonly configService: ConfigService) {}

  @Get('robots.txt')
  @Public()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  robots(): string {
    const isDemo =
      this.configService.get<string>('IS_DEMO', 'false') === 'true';

    if (isDemo) {
      return [
        '# Veridian Analytics — public demo (demo-analytics.veridian.site)',
        '#',
        '# The landing page is indexable so the demo is discoverable, but the',
        '# workspace dashboards expose generated/fictional dates we do not want',
        '# polluting search results.',
        '',
        'User-agent: *',
        'Allow: /$',
        'Disallow: /workspaces',
        'Disallow: /api/',
        'Disallow: /login',
        'Disallow: /setup',
        '',
        'Sitemap: https://demo-analytics.veridian.site/sitemap.xml',
        '',
      ].join('\n');
    }

    // Internal / tenant SaaS deployment — never indexed.
    return [
      '# Veridian Analytics — internal / tenant deployment',
      '#',
      '# Tenants reach this console via magic link from the Veridian Hub,',
      '# not via search engines. Disallow everything.',
      '',
      'User-agent: *',
      'Disallow: /',
      '',
    ].join('\n');
  }
}
