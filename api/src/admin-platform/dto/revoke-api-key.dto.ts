import {
  IsString,
  IsOptional,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /api/admin/platform/workspaces.revokeApiKey (M2M).
 *
 * Symmetric of ProvisionApiKeyDto: revokes a workspace-scoped key for a
 * platform-managed workspace. The key is identified by `key_id` OR
 * `key_prefix` (at least one required). `key_prefix` is the handle the
 * caller keeps from provisionApiKey's response.
 */
export class RevokeApiKeyDto {
  @ApiProperty({ description: 'Workspace owning the key to revoke.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    description:
      'Internal API key id. Provide this OR key_prefix (at least one).',
  })
  @ValidateIf((o: RevokeApiKeyDto) => !o.key_prefix)
  @IsString()
  @IsNotEmpty()
  key_id?: string;

  @ApiProperty({
    required: false,
    description:
      'API key prefix (returned by provisionApiKey). Provide this OR key_id.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  key_prefix?: string;
}
