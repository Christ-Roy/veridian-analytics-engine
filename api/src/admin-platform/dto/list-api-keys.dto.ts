import { IsString, IsOptional, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { ApiKeyStatus } from '../../common/entities/api-key.entity';

/**
 * Body for POST /api/admin/platform/workspaces.listApiKeys (M2M).
 * Lists the API keys of a platform-managed workspace for audit.
 */
export class ListWorkspaceApiKeysDto {
  @ApiProperty({ description: 'Workspace whose keys to list.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    enum: ['active', 'revoked', 'expired'],
    description: 'Optional status filter.',
  })
  @IsOptional()
  @IsIn(['active', 'revoked', 'expired'])
  status?: ApiKeyStatus;
}
