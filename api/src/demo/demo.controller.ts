import {
  Controller,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DemoService, DEMO_USER_NAME, DEMO_WORKSPACE_ID } from './demo.service';
import { DemoProtected } from './decorators/demo-protected.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('demo')
@Controller('api')
export class DemoController {
  constructor(
    private readonly demoService: DemoService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Public runtime configuration consumed by the SPA at boot.
   *
   * The frontend bundle is built ONCE and shipped in every image (prod,
   * staging, demo). It cannot know at build time whether it runs in demo
   * mode, so it polls this endpoint on startup. When `is_demo` is true the
   * console:
   *  - auto-logs the visitor in via `POST /api/demo.login`
   *  - renders the Veridian demo banner + marketing CTAs
   *  - swaps the document title / favicon to Veridian branding
   */
  @Get('public-config')
  @Public()
  @ApiOperation({ summary: 'Public runtime config (demo flag, branding)' })
  publicConfig(): {
    is_demo: boolean;
    demo_workspace_id: string;
    contact_email: string;
  } {
    const isDemo =
      this.configService.get<string>('IS_DEMO', 'false') === 'true';
    return {
      is_demo: isDemo,
      demo_workspace_id: DEMO_WORKSPACE_ID,
      contact_email: 'robert.brunon@veridian.site',
    };
  }

  @Post('demo.generate')
  @Public()
  @DemoProtected()
  @ApiOperation({ summary: 'Generate demo fixtures (200k sessions over 90d)' })
  async generate() {
    return this.demoService.generate();
  }

  @Post('demo.delete')
  @Public()
  @DemoProtected()
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete demo workspace and sessions' })
  async delete() {
    return this.demoService.delete();
  }

  /**
   * Anonymous auto-login for the public demo instance.
   *
   * Only available when `IS_DEMO=true`. Returns a short-lived JWT for the
   * dedicated `demo@veridian.site` user (created by `demo.generate`), so
   * visitors of `https://demo-analytics.veridian.site` can browse the
   * read-only `demo-apple` workspace without any credentials.
   *
   * On a non-demo build, this endpoint returns 403 (defense in depth: it
   * should not even be reachable in production, since the controller is
   * mounted but `IS_DEMO` is unset).
   */
  @Post('demo.login')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anonymous login for the public demo (IS_DEMO=true only)',
  })
  async login() {
    const isDemo =
      this.configService.get<string>('IS_DEMO', 'false') === 'true';

    if (!isDemo) {
      throw new ForbiddenException(
        'Demo auto-login is only enabled when IS_DEMO=true',
      );
    }

    const user = await this.demoService.findDemoUser();
    if (!user) {
      // Demo data has not been seeded yet (cron is running, or fresh deploy).
      throw new ServiceUnavailableException(
        'Demo data is being generated. Please retry in a moment.',
      );
    }

    // Mint a JWT tied to the demo user with no session row in ClickHouse
    // (we don't want to persist a session for a public account; the JWT
    // simply identifies the bearer as the demo user). The JwtAuthGuard
    // validates `sub` against the users table, not sessions.
    const payload = {
      sub: user.id,
      email: user.email,
      // No sessionId on purpose — see JwtAuthGuard.
      isDemo: true,
    };
    const accessToken = this.jwtService.sign(payload);

    return {
      access_token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? DEMO_USER_NAME,
        is_super_admin: false,
      },
    };
  }
}
