import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /api/admin/platform/ads.conversions (M2M, Lot F).
 *
 * READ-only: returns the conversions attributed to Google Ads for a workspace
 * so an IA / the platform google-ads skill can read them and upload them to the
 * Ads API. The upload itself is NOT done here (no Ads credentials, no OAuth —
 * that stays in the skill). Pure analytics read over ClickHouse `events`.
 */
export class AdsConversionsDto {
  @ApiProperty({ description: 'Workspace to read Ads-attributed conversions for.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({
    required: false,
    description: 'ISO-8601 lower bound (inclusive). Default: now - 28 days.',
    example: '2026-05-24T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({
    required: false,
    description: 'ISO-8601 upper bound (inclusive). Default: now.',
    example: '2026-06-21T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 10000,
    default: 1000,
    description: 'Max rows returned (default 1000, hard cap 10000).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}
