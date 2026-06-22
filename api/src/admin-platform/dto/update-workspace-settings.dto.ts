import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UpdateWorkspaceSettingsDto } from '../../workspaces/dto/update-workspace.dto';
import type { WorkspaceStatus } from '../../workspaces/entities/workspace.entity';

/**
 * Body for POST /api/admin/platform/workspaces.updateSettings (M2M).
 *
 * Keyed on `workspace_id` (the M2M convention) instead of the console's `id`,
 * then mapped onto `UpdateWorkspaceDto` before delegating to WorkspacesService.
 * Re-uses the canonical `UpdateWorkspaceSettingsDto` so deep settings validation
 * (annotations, smtp, filters, geo…) is identical to the console path.
 */
export class UpdateWorkspaceSettingsM2MDto {
  @ApiProperty({ description: 'Workspace to update.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(['initializing', 'active', 'inactive', 'error'])
  status?: WorkspaceStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiProperty({ required: false, example: 'Europe/Paris' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({ required: false, example: 'EUR' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  logo_url?: string;

  @ApiProperty({ required: false, type: UpdateWorkspaceSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateWorkspaceSettingsDto)
  settings?: UpdateWorkspaceSettingsDto;
}
