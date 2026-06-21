import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Search Console M2M admin DTOs.
 *
 * Only `status` and `resync` are exposed: the OAuth begin/callback flow stays
 * a HUMAN, browser-driven consent (no M2M path) — an IA cannot grant Google
 * consent on a user's behalf, so we deliberately do NOT expose gsc.begin here.
 */

/** POST gsc.status — read the GSC connection state of a workspace. */
export class GscStatusDto {
  @ApiProperty({ description: 'Workspace whose GSC connection to inspect.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}

/** POST gsc.resync — trigger an immediate GSC sync for a connected workspace. */
export class GscResyncDto {
  @ApiProperty({ description: 'Workspace to resync (must be GSC-connected).' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 90,
    default: 30,
    description: 'Look-back window in days (default 30).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
