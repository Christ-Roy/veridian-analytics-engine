import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * `analytics.prospect360` (M2M) — request.
 *
 * The single M2M call an IA / the Hub makes to get a giga-complete fiche on ONE
 * identified prospect. Composes (does NOT re-implement) three already-shipped
 * read paths under ONE platform key:
 *   • provenance      → reuses `userProvenance` (user_attribution, first/last touch)
 *   • journey         → reuses `ExportService.getUserEvents` (chronological events)
 *   • ads_conversions → reuses `getAdsConversions`, filtered on this user
 *
 * The trou this fixes: `export.userEvents` (the journey) was gated by the
 * WORKSPACE key (stam_live_*), unreachable with the PLATFORM key the IA/Hub
 * holds. prospect360 exposes it (and the rest) under PlatformAdminGuard.
 */
export class Prospect360Dto {
  @ApiProperty({
    description: 'Workspace the prospect belongs to.',
  })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    description:
      'The identified prospect (user_id = email/id, the value posted at login). ' +
      'Required — this is a per-prospect fiche, not a list.',
  })
  @IsString()
  @IsNotEmpty()
  user: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 7,
    default: 7,
    description:
      'How many days back to read the DETAILED chronological journey. ' +
      'Bounded by the events TTL (7 days, raw events are deleted past that) — ' +
      'the response echoes the effective window in `journey_window_days` so the ' +
      'consumer knows the detailed parcours is only the last N days; aggregates ' +
      '(sessions 30d / user_attribution) live beyond it. Default & cap = 7.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  journey_days?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 1000,
    default: 500,
    description:
      'Max chronological events returned in the journey (oldest→newest, capped). ' +
      'Default 500, cap 1000. `journey_truncated` flags when more existed.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  journey_limit?: number;
}
