import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /api/admin/platform/tracking.verify (M2M).
 *
 * Dry-run install check: after an IA pastes the tracker snippet on a client
 * site, this single call confirms the tracking is wired end-to-end WITHOUT
 * polluting the real analytics of the workspace.
 *
 * `workspace_id` validation mirrors the other M2M DTOs (`@IsString` +
 * `@IsNotEmpty`); the canonical slug regex (`^[a-z][a-z0-9_]*$`) is enforced
 * server-side in AdminPlatformService (workspaceExists / useExplicitWorkspaceId)
 * — we keep the DTO lenient here, exactly like workspaces.status / voip.* do.
 */
export class TrackingVerifyDto {
  @ApiProperty({ description: 'Workspace whose tracking to verify (dry-run).' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    description:
      'OPTIONAL public URL of the client site. When supplied, the HTML is ' +
      'fetched (5s timeout, fail-soft) to confirm the tracker <script> is ' +
      'present, points at /sdk/v1/tracker.js, and carries the right ' +
      'data-workspace-id. Omit to only check ingestion + real tracking.',
    example: 'https://client-site.example',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  site_url?: string;
}
