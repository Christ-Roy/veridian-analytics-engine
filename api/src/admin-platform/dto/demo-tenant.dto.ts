import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for POST /api/admin/platform/demo.seed (M2M).
 *
 * Seeds synthetic-but-realistic demo data INTO an existing workspace so a
 * prospect sees the product alive. Every row carries the `vrddemo_` session_id
 * prefix and a `_demo=1` property tag, so demo.wipe removes it surgically while
 * leaving the client's real data untouched.
 */
export class DemoSeedDto {
  @ApiProperty({ description: 'Existing workspace to seed demo data into.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiPropertyOptional({
    description: 'Number of web sessions to synthesize (default 4000, 1..50000).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50_000)
  session_count?: number;

  @ApiPropertyOptional({
    description: 'Number of VoIP phone_call goals to synthesize (default 40, 0..5000).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5_000)
  voip_count?: number;

  @ApiPropertyOptional({
    description: 'Window depth in days the data spans (default 30, 1..365).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days_range?: number;

  @ApiPropertyOptional({
    description:
      'Seed even if the workspace already holds REAL (non-demo) events. ' +
      'Default false → refuse with 409 DEMO_REAL_DATA_PRESENT to protect real traffic.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Body for POST /api/admin/platform/demo.wipe (M2M). */
export class DemoWipeDto {
  @ApiProperty({ description: 'Workspace whose demo data to wipe.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}

/** Body for POST /api/admin/platform/demo.status (M2M). */
export class DemoStatusDto {
  @ApiProperty({ description: 'Workspace whose demo state to read.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}
