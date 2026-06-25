import { ApiProperty } from '@nestjs/swagger';

/**
 * Raw row as read from `user_attribution` (dates pre-stringified by toString()).
 * Internal — not the API contract (that's UserProvenanceEntry below).
 */
export interface UserProvenanceRowRaw {
  identity_key: string;
  user_id: string;
  first_touch_channel: string;
  first_touch_channel_group: string;
  first_touch_referrer: string;
  first_touch_referrer_domain: string;
  first_touch_landing_page: string;
  first_touch_utm_source: string;
  first_touch_utm_medium: string;
  first_touch_utm_campaign: string;
  first_touch_utm_content: string;
  first_touch_at: string;
  first_touch_method: string;
  last_touch_channel: string;
  last_touch_channel_group: string;
  last_touch_at: string;
  referral_code: string;
}

/** Provenance of one identified user (stitched first-touch acquisition). */
export class UserProvenanceEntry {
  @ApiProperty({ description: 'The identified user (email / user_id).' })
  user_id: string;

  @ApiProperty({
    description: 'Stitched first-touch channel (e.g. organic_search, paid_search).',
  })
  first_touch_channel: string;

  @ApiProperty({
    description:
      'Stitched first-touch channel group — the acquisition bucket the user ' +
      'REALLY came from (seo/ads/referral/social/…), recovered from their first ' +
      'anonymous vitrine session. This is the KPI answer S6 fixes.',
  })
  first_touch_channel_group: string;

  @ApiProperty({ description: 'First-touch referrer URL.' })
  first_touch_referrer: string;

  @ApiProperty({ description: 'First-touch referrer domain.' })
  first_touch_referrer_domain: string;

  @ApiProperty({ description: 'First-touch landing page URL.' })
  first_touch_landing_page: string;

  @ApiProperty({ description: 'First-touch utm_source.' })
  first_touch_utm_source: string;

  @ApiProperty({ description: 'First-touch utm_medium.' })
  first_touch_utm_medium: string;

  @ApiProperty({ description: 'First-touch utm_campaign.' })
  first_touch_utm_campaign: string;

  @ApiProperty({
    description:
      'First-touch utm_content. Mirrors referral_code for parrainage (?ref=).',
  })
  first_touch_utm_content: string;

  @ApiProperty({
    nullable: true,
    description: 'First-touch timestamp (ClickHouse DateTime string, UTC), or null.',
  })
  first_touch_at: string | null;

  @ApiProperty({
    description:
      'Which join key linked the chain: session_id | visitor_id | fingerprint ' +
      '(audit/confidence of the stitch). Empty if no stitch.',
  })
  first_touch_method: string;

  @ApiProperty({
    description: 'Last-touch channel — the session where the user identified.',
  })
  last_touch_channel: string;

  @ApiProperty({
    description:
      'Last-touch channel group — usually `direct` (the /login session). GA4 ' +
      'exposes both first- and last-touch; we keep both.',
  })
  last_touch_channel_group: string;

  @ApiProperty({
    nullable: true,
    description: 'Last-touch timestamp (ClickHouse DateTime string, UTC), or null.',
  })
  last_touch_at: string | null;

  @ApiProperty({
    description:
      'Parrainage code (?ref=<code>), if this user was referred. Empty otherwise.',
  })
  referral_code: string;
}

/** POST analytics.userProvenance — response. */
export class UserProvenanceResponseDto {
  @ApiProperty({ description: 'Workspace the provenance was read for.' })
  workspace_id: string;

  @ApiProperty({ description: 'Number of identified users returned.' })
  count: number;

  @ApiProperty({
    type: [UserProvenanceEntry],
    description: 'One provenance entry per identified user.',
  })
  users: UserProvenanceEntry[];
}
