import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import {
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { WorkspaceAuthGuard } from '../common/guards/workspace.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { Public } from '../common/decorators/public.decorator';
import { GscService } from './gsc.service';
import { GscQueryService } from './gsc-query.service';
import { GscOauthConfigError, GscOauthFlowError } from './gsc-oauth.service';
import { GscDashboardQueryDto, GscWorkspaceDto } from './dto/gsc.dto';

/**
 * Endpoints GSC natifs de l'engine — remplacent les routes admin du bridge
 * (`/api/admin/gsc/*` + `/api/admin/tenant/:ws/gsc`).
 *
 * AUTH : tout est protégé par l'auth engine native (clé API workspace OU
 * session JWT membre du workspace) via `WorkspaceAuthGuard` + permission —
 * PLUS de Bearer admin global qui voyait tous les tenants. SEULE exception :
 * `oauth-callback`, appelé par la redirection Google (pas d'utilisateur dans
 * la requête), protégé à la place par la signature HMAC du `state`.
 *
 * La shape de `dashboard` est identique à celle de l'ancien bridge
 * (`GscDashboardResponse` côté console) → l'UI ne change pas.
 */
@ApiTags('gsc')
@ApiSecurity('api-key')
@ApiSecurity('jwt-auth')
@Controller('api/gsc')
export class GscController {
  constructor(
    private readonly gsc: GscService,
    private readonly query: GscQueryService,
    private readonly config: ConfigService,
  ) {}

  // ─── Dashboard (lecture) ───────────────────────────────────────────

  @Get('dashboard')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('gsc.read')
  @ApiOperation({
    summary:
      'Résumé Search Console (totals pondérés + top requêtes/pages + timeseries).',
  })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  @ApiQuery({ name: 'days', type: Number, required: false })
  async dashboard(@Query() q: GscDashboardQueryDto) {
    const days = q.days ?? 28;
    const summary = await this.query.dashboardSummary({
      workspaceId: q.workspace_id,
      days,
    });
    // Miroir exact de l'ancienne réponse bridge consommée par la console.
    return { workspaceId: q.workspace_id, days, ...summary };
  }

  @Get('status')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('gsc.read')
  @ApiOperation({
    summary: 'État de la connexion GSC du workspace (connecté, propriété, sync).',
  })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  async status(@Query('workspace_id') workspaceId: string) {
    if (!workspaceId) throw new BadRequestException('workspace_id is required');
    return this.gsc.status(workspaceId);
  }

  // ─── OAuth ──────────────────────────────────────────────────────────

  @Post('oauth-begin')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('gsc.manage')
  @ApiOperation({
    summary: "Démarre le flow OAuth Google et renvoie l'URL de consentement.",
  })
  async oauthBegin(@Body() dto: GscWorkspaceDto) {
    if (!this.gsc.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'GSC_NOT_CONFIGURED',
        message: 'GSC OAuth is not configured on this instance.',
      });
    }
    return this.gsc.beginOauth(dto.workspace_id);
  }

  /**
   * Callback Google. PUBLIC car appelé par la redirection du navigateur depuis
   * accounts.google.com (aucune clé API / session dans la requête). La sécurité
   * repose sur la signature HMAC du `state` (cf GscOauthService.parseState) :
   * un attaquant ne peut pas forger un callback pour un autre workspace.
   *
   * En succès, redirige vers la console (onglet Settings → Search Console) si
   * `GSC_OAUTH_SUCCESS_REDIRECT` est configuré, sinon renvoie un JSON.
   */
  @Get('oauth-callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth Google (redirection navigateur).' })
  @ApiQuery({ name: 'code', type: String, required: false })
  @ApiQuery({ name: 'state', type: String, required: false })
  @ApiQuery({ name: 'error', type: String, required: false })
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
    @Query('error') error?: string,
  ): Promise<void> {
    const redirectBase = this.config.get<string>('GSC_OAUTH_SUCCESS_REDIRECT');

    if (error) {
      // L'utilisateur a refusé le consent, ou Google a renvoyé une erreur.
      this.redirectOrJson(res, redirectBase, { gsc: 'error', reason: error }, 400, {
        ok: false,
        error: 'oauth_denied',
      });
      return;
    }
    if (!code || !state) {
      throw new BadRequestException('missing_code_or_state');
    }

    try {
      const { workspaceId, siteUrl } = await this.gsc.handleCallback(
        code,
        state,
      );
      this.redirectOrJson(
        res,
        redirectBase,
        { gsc: 'connected', workspace_id: workspaceId },
        200,
        { ok: true, workspaceId, siteUrl },
      );
    } catch (err) {
      if (err instanceof GscOauthFlowError) {
        this.redirectOrJson(
          res,
          redirectBase,
          { gsc: 'error', reason: err.message },
          err.status ?? 400,
          { ok: false, error: 'oauth_flow_error', message: err.message },
        );
        return;
      }
      if (err instanceof GscOauthConfigError) {
        throw new ServiceUnavailableException({
          code: 'GSC_NOT_CONFIGURED',
          message: err.message,
        });
      }
      throw err;
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────

  @Post('resync')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('gsc.manage')
  @ApiOperation({ summary: 'Resynchronise immédiatement les données GSC.' })
  async resync(@Body() dto: GscWorkspaceDto) {
    return this.gsc.resync(dto.workspace_id, 30);
  }

  @Post('disconnect')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('gsc.manage')
  @ApiOperation({ summary: 'Déconnecte la propriété GSC (purge le token).' })
  async disconnect(@Body() dto: GscWorkspaceDto) {
    return this.gsc.disconnect(dto.workspace_id);
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private redirectOrJson(
    res: Response,
    redirectBase: string | undefined,
    params: Record<string, string>,
    status: number,
    jsonBody: Record<string, unknown>,
  ): void {
    if (redirectBase) {
      try {
        const url = new URL(redirectBase);
        for (const [k, v] of Object.entries(params)) {
          url.searchParams.set(k, v);
        }
        res.redirect(302, url.toString());
        return;
      } catch {
        // redirectBase mal formé → fallback JSON ci-dessous.
      }
    }
    res.status(status).json(jsonBody);
  }
}
