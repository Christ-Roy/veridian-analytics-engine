import { IsString, IsOptional, IsIn, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const API_KEY_ROLES = ['admin', 'editor', 'viewer'] as const;

/**
 * Body for POST /api/admin/platform/workspaces.provisionApiKey (M2M).
 * Provisions a workspace-scoped API key for an existing platform-managed
 * workspace that has no members. Cf task #8.
 */
export class ProvisionApiKeyDto {
  @ApiProperty({ description: 'Existing workspace to provision a key for.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ required: false, description: 'Human-friendly key name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, enum: API_KEY_ROLES, default: 'admin' })
  @IsOptional()
  @IsIn(API_KEY_ROLES)
  role?: 'admin' | 'editor' | 'viewer';
}
