import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * S6 Lot C — `analytics.userProvenance` (M2M).
 *
 * Reads the canonical `user_attribution` table (stitched first/last touch per
 * identified user, written by IdentityStitchService at ingestion + the identity
 * backfill) and returns, per signed-up user, WHERE THEY CAME FROM — the answer
 * to the KPI "d'où viennent mes clients" that S6 fixes (Joséphine/Valentin/…
 * were all wrongly `direct`/`not-mapped` before the stitch).
 *
 * Modelled on `analytics.query`: workspace-scoped, optional single-user filter.
 */

/** POST analytics.userProvenance — request. */
export class UserProvenanceDto {
  @ApiProperty({
    description: 'Workspace whose identified-user provenance to read.',
  })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    description:
      'Restrict to a single user (identity_key = the user email/id). ' +
      'Omit to list every identified user of the workspace.',
  })
  @IsOptional()
  @IsString()
  user?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 10000,
    default: 1000,
    description: 'Max users returned (default 1000, cap 10000).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}
