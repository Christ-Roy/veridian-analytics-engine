import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WorkspaceAuthGuard } from '../common/guards/workspace.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { VoipService } from './voip.service';
import { VoipSyncService } from './voip-sync.service';
import {
  CreatePhoneNumberDto,
  DeleteCredentialDto,
  DeletePhoneNumberDto,
  SaveCredentialDto,
  TestCredentialDto,
  UpdatePhoneNumberDto,
} from './dto/voip.dto';

/**
 * API VoIP native (port du bridge VoIP — option A, ticket 2026-06-16).
 *
 * Convention staminads : endpoints `voip.<verbe>` sous `/api`, auth
 * `WorkspaceAuthGuard` (JWT console OU api-key M2M) + `@RequirePermission`.
 *
 * PAS d'endpoint "liste d'appels" : la vision Robert (2026-05-23) bannit la
 * page Calls — les appels vivent dans Live/Explore/Goals natifs (events
 * `phone_call`). Ce controller ne fait que : config (creds + numéros) +
 * statut sync.
 */
@ApiTags('voip')
@ApiSecurity('api-key')
@ApiSecurity('jwt-auth')
@Controller('api')
export class VoipController {
  constructor(
    private readonly voip: VoipService,
    private readonly sync: VoipSyncService,
  ) {}

  // ─── Vue agrégée (consommée par le panel Settings VoIP) ───────────

  @Get('voip.settings')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.read')
  @ApiOperation({
    summary:
      'État VoIP d’un workspace : credentials (masqués) + numéros trackés.',
  })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  async settings(@Query('workspace_id') workspaceId: string) {
    const [credentials, numbers] = await Promise.all([
      this.voip.listCredentials(workspaceId),
      this.voip.listPhoneNumbers(workspaceId),
    ]);
    return {
      credentials,
      phoneNumbers: numbers.phoneNumbers,
      allowedSources: numbers.allowedSources,
    };
  }

  // ─── Credentials ──────────────────────────────────────────────────

  @Post('voip.saveCredential')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({ summary: 'Enregistre/remplace un credential VoIP (chiffré).' })
  async saveCredential(@Body() dto: SaveCredentialDto) {
    const credential = await this.voip.saveCredential(
      dto.workspace_id,
      dto.kind,
      dto.creds,
    );
    return { ok: true, credential };
  }

  @Post('voip.testCredential')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.test')
  @ApiOperation({ summary: 'Teste un credential contre l’API du provider.' })
  async testCredential(@Body() dto: TestCredentialDto) {
    const result = await this.voip.testCredential(dto.workspace_id, dto.kind);
    return { ok: result.ok, message: result.message, status: result.status };
  }

  @Post('voip.deleteCredential')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({ summary: 'Soft-delete un credential VoIP.' })
  async deleteCredential(@Body() dto: DeleteCredentialDto) {
    return this.voip.deleteCredential(dto.workspace_id, dto.kind);
  }

  // ─── Numéros trackés (1 numéro = 1 source) ────────────────────────

  @Get('voip.listPhoneNumbers')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.read')
  @ApiOperation({ summary: 'Liste les numéros trackés + sources autorisées.' })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  async listPhoneNumbers(@Query('workspace_id') workspaceId: string) {
    return this.voip.listPhoneNumbers(workspaceId);
  }

  @Post('voip.createPhoneNumber')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({ summary: 'Mappe un numéro de téléphone à une source.' })
  async createPhoneNumber(@Body() dto: CreatePhoneNumberDto) {
    const phoneNumber = await this.voip.createPhoneNumber(
      dto.workspace_id,
      dto.e164,
      dto.source,
      dto.label ?? null,
    );
    return { ok: true, phoneNumber };
  }

  @Post('voip.updatePhoneNumber')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({ summary: 'Modifie source/label d’un numéro tracké.' })
  async updatePhoneNumber(@Body() dto: UpdatePhoneNumberDto) {
    const phoneNumber = await this.voip.updatePhoneNumber(
      dto.workspace_id,
      dto.id,
      { source: dto.source, label: dto.label },
    );
    return { ok: true, phoneNumber };
  }

  @Post('voip.deletePhoneNumber')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({ summary: 'Soft-delete un numéro tracké.' })
  async deletePhoneNumber(@Body() dto: DeletePhoneNumberDto) {
    return this.voip.deletePhoneNumber(dto.workspace_id, dto.id);
  }

  // ─── Sync manuel (déclenchement à la demande, ex. après config) ───

  @Post('voip.sync')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('voip.write')
  @ApiOperation({
    summary:
      'Déclenche une synchro VoIP immédiate (tous credentials actifs). Le cron tourne aussi toutes les 15 min.',
  })
  // workspace_id est requis par le guard mais le sync couvre tous les
  // workspaces actifs — c'est volontaire (un opérateur peut forcer un run).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async syncNow(@Body() _dto: { workspace_id: string }) {
    const result = await this.sync.syncAll();
    return { ok: true, ...result };
  }
}
