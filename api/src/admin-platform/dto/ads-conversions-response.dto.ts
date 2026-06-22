import { ApiProperty } from '@nestjs/swagger';

/**
 * The kind of Ads attribution that produced a conversion.
 *
 * - gclid / gbraid / wbraid : a web conversion (goal) carrying a Google Ads
 *   click id on its session (`utm_id_from` = the click-id type, `click_id` =
 *   the raw value from `utm_id`). These are uploadable as click-conversions.
 * - phone_source_ads : a tracked phone call whose number is mapped to the
 *   `ads` source (`properties.source='ads'`). No gclid — attribution is by the
 *   dialed number, not a click id (uploadable as a call/enhanced conversion).
 */
export type AdsClickIdSource = 'gclid' | 'gbraid' | 'wbraid' | 'phone_source_ads';

/** A single Ads-attributed conversion. */
export class AdsConversionDto {
  @ApiProperty({
    enum: ['gclid', 'gbraid', 'wbraid', 'phone_source_ads'],
    description: 'How this conversion was attributed to Google Ads.',
  })
  click_id_source: AdsClickIdSource;

  @ApiProperty({
    nullable: true,
    description:
      'Raw click id (gclid/gbraid/wbraid value). Null for phone_source_ads (attribution is by dialed number, no click id).',
  })
  click_id: string | null;

  @ApiProperty({
    description:
      'Conversion type = the goal name (e.g. "form_submission", "phone_call").',
  })
  conversion_type: string;

  @ApiProperty({ description: 'Conversion timestamp (ISO-8601 UTC).' })
  timestamp: string;

  @ApiProperty({
    description: 'Conversion value when available (goal_value), else 0.',
  })
  value: number;

  @ApiProperty({
    nullable: true,
    description: 'Identified user id when present, else null.',
  })
  user_id: string | null;

  @ApiProperty({ description: 'Path the conversion happened on.' })
  path: string;

  @ApiProperty({
    nullable: true,
    description: 'Phone source label/number for phone conversions, else null.',
  })
  phone_number: string | null;
}

/** Response of POST ads.conversions (M2M, Lot F). */
export class AdsConversionsResponseDto {
  @ApiProperty()
  workspace_id: string;

  @ApiProperty({ description: 'Applied lower bound (ISO-8601 UTC).' })
  from: string;

  @ApiProperty({ description: 'Applied upper bound (ISO-8601 UTC).' })
  to: string;

  @ApiProperty({ description: 'Applied row cap.' })
  limit: number;

  @ApiProperty({ description: 'Number of conversions returned.' })
  count: number;

  @ApiProperty({
    description:
      'True when the row cap was hit (more conversions exist — narrow the date range or paginate by date).',
  })
  truncated: boolean;

  @ApiProperty({ type: [AdsConversionDto] })
  conversions: AdsConversionDto[];
}
