import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /api/admin/platform/workspaces.status (M2M).
 *
 * Returns a consolidated, IA-readable snapshot of a workspace: existence,
 * tracking liveness, and the state of every connector (GSC / VoIP / webhooks).
 * Composed entirely from existing domain services — no new query logic.
 */
export class WorkspaceStatusDto {
  @ApiProperty({ description: 'Workspace whose consolidated status to read.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}
