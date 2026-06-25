import { ApiProperty } from '@nestjs/swagger';
import { UserProvenanceEntry } from './user-provenance-response.dto';
import { AdsConversionDto } from './ads-conversions-response.dto';

/**
 * One step of the prospect's chronological journey — a lean projection of an
 * `events` row (one screen_view OR one goal), oldest→newest. Derived from the
 * SAME read path as `export.userEvents` (ExportService.getUserEvents) so there
 * is zero query duplication: we keep only the fields that tell "what they did".
 */
export class Prospect360JourneyStep {
  @ApiProperty({ enum: ['screen_view', 'goal'], description: 'Event kind.' })
  type: 'screen_view' | 'goal';

  @ApiProperty({ description: 'When it happened (ClickHouse DateTime string, UTC).' })
  at: string;

  @ApiProperty({ description: 'Page path of the event.' })
  path: string;

  @ApiProperty({ description: 'Session this event belongs to.' })
  session_id: string;

  @ApiProperty({
    nullable: true,
    description: 'Goal name for goal events (e.g. signup, form_submission, phone_call), else null.',
  })
  goal_name: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Goal value when present, else null.',
  })
  goal_value: number | null;

  @ApiProperty({
    description: 'Per-event (session/last-touch) channel group — how THIS visit was attributed.',
  })
  channel_group: string;

  @ApiProperty({ description: 'Time spent on the page in ms (0 for goals).' })
  duration: number;

  @ApiProperty({ description: 'Max scroll depth % reached on the page.' })
  max_scroll: number;

  @ApiProperty({ description: 'Position of the page within its session (1-based).' })
  page_number: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Custom goal properties (Map). Empty for screen_view / plain goals.',
  })
  properties: Record<string, string>;
}

/** "Has this prospect an account / is it identified" block. */
export class Prospect360Account {
  @ApiProperty({
    description:
      'True when the prospect is identified — i.e. a user_attribution row exists ' +
      '(they logged in / signed up at least once). False = anonymous, never stitched.',
  })
  created: boolean;

  @ApiProperty({
    nullable: true,
    description: 'The resolved user_id (echoes the requested user), or null if unknown.',
  })
  user_id: string | null;

  @ApiProperty({
    nullable: true,
    description: 'First-touch timestamp = effectively "first seen" (from provenance), or null.',
  })
  first_seen_at: string | null;
}

/**
 * Response of POST analytics.prospect360 (M2M) — the giga-complete fiche of ONE
 * prospect in a single call: where they come from, whether they have an account,
 * what they did (chronological journey), and their Google Ads conversions.
 *
 * Each block degrades to a safe empty value (never a 500) when the prospect has
 * no data for it — an unknown user yields `found:false` + empty blocks.
 */
export class Prospect360ResponseDto {
  @ApiProperty()
  workspace_id: string;

  @ApiProperty({ description: 'The requested prospect (user_id = email/id).' })
  user: string;

  @ApiProperty({
    description:
      'True when ANY trace of this prospect exists (provenance OR journey OR a ' +
      'conversion). False = the user_id is unknown to this workspace (all blocks empty).',
  })
  found: boolean;

  @ApiProperty({
    nullable: true,
    type: UserProvenanceEntry,
    description: 'First/last-touch acquisition provenance (stitched), or null if not identified.',
  })
  provenance: UserProvenanceEntry | null;

  @ApiProperty({ type: Prospect360Account })
  account: Prospect360Account;

  @ApiProperty({
    description:
      'Effective look-back window (days) of the DETAILED journey below. Bounded by ' +
      'the events TTL (7 days) — older raw events are gone; sessions/aggregates live ' +
      'beyond. Tells the consumer the parcours is "last N days" only.',
  })
  journey_window_days: number;

  @ApiProperty({
    description: 'True when the journey row cap was hit (more events existed in-window).',
  })
  journey_truncated: boolean;

  @ApiProperty({
    type: [Prospect360JourneyStep],
    description: 'Chronological parcours (oldest→newest) within the journey window.',
  })
  journey: Prospect360JourneyStep[];

  @ApiProperty({
    type: [AdsConversionDto],
    description: 'Google Ads-attributed conversions of THIS prospect (filtered by user_id).',
  })
  ads_conversions: AdsConversionDto[];
}
