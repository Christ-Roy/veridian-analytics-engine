import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * S6 Lot C — `backfill.identity` (M2M).
 *
 * Triggers a synchronous re-stitch of every HISTORICAL identified user of a
 * workspace: re-runs IdentityStitchService over each past signup so users who
 * signed up BEFORE S6 shipped (Joséphine/Valentin/Michele) finally get their
 * first-touch acquisition written to `user_attribution` + denormalized onto
 * their sessions/goals. Idempotent, total-preserving, scoped.
 */
export class IdentityBackfillDto {
  @ApiProperty({
    description:
      'Workspace whose historical identified users to re-stitch (first-touch).',
  })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}
