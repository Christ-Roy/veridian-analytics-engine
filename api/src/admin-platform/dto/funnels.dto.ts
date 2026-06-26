import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  DateRangeDto,
  DateRangeValidator,
  FilterDto,
} from '../../analytics/dto/analytics-query.dto';
import { WorkspaceFunnelDto } from '../../workspaces/dto/update-workspace.dto';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';

/**
 * M2M bodies for the per-workspace NAMED FUNNELS surface (VAGUE 2 customisation).
 *
 * A named funnel = an ordered list of goal/event steps DEFINED & PERSISTED per
 * workspace (settings JSON, zero migration), so each client owns its own
 * conversion funnel (tracker adapted: phone, form, purchase, signup…) instead of
 * passing `steps` on every `analytics.funnel` call. Generalises the data-driven
 * `crm_mapping.goals[]` pattern (already shipped) to the sales funnel.
 *
 * The funnel definition shape itself (`WorkspaceFunnelDto`) is reused from the
 * workspace persistence DTO (same pattern as customization.dto reusing
 * CrmMappingDto/BrandingDto) — one validation contract, zero drift between the
 * M2M surface and what is persisted.
 *
 * Three verbs: funnels.set (define/replace the catalogue), funnels.get (read it),
 * funnels.run (execute ONE funnel BY NAME — resolves the persisted steps then
 * runs the same windowFunnel engine as analytics.funnel).
 */

class WorkspaceKeyedDto {
  @ApiProperty({ description: 'Target workspace id.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}

/**
 * POST /funnels.set — define/replace the workspace's funnel catalogue.
 *
 * FULL-REPLACE semantics on the LIST: the `funnels` array sent REPLACES the
 * whole persisted catalogue (it is NOT appended/merged per-name). Send the full
 * desired set; send `[]` to clear all funnels. This keeps the contract simple
 * and predictable — the same explicit full-replace the M2M layout verb uses for
 * its `order` array. Names must be unique within the body (case-insensitive,
 * enforced in the service).
 */
export class SetFunnelsDto extends WorkspaceKeyedDto {
  @ApiProperty({
    type: [WorkspaceFunnelDto],
    description:
      'Full funnel catalogue (FULL-REPLACE). Empty array clears all funnels. ' +
      'Each funnel: {name(slug), label?, steps[2..8], default_unit?, default_window_seconds?}.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceFunnelDto)
  funnels: WorkspaceFunnelDto[];
}

/** POST /funnels.get — read the persisted funnel catalogue. */
export class GetFunnelsDto extends WorkspaceKeyedDto {}

/**
 * POST /funnels.run — execute ONE persisted funnel BY NAME.
 *
 * Resolves the named funnel's persisted steps (+ its default unit/window) and
 * runs the SAME windowFunnel engine as analytics.funnel. The date range is
 * required (a funnel is always computed over a window); `unit` /
 * `window_seconds` / `filters` / `timezone` OVERRIDE the funnel's stored
 * defaults when supplied. Unknown name → 404 FUNNEL_NOT_FOUND.
 */
export class RunFunnelDto extends WorkspaceKeyedDto {
  @ApiProperty({ description: 'Name of the persisted funnel to execute.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({ type: DateRangeDto })
  @Validate(DateRangeValidator)
  @ValidateNested()
  @Type(() => DateRangeDto)
  dateRange: DateRangeDto;

  @ApiProperty({
    required: false,
    type: [FilterDto],
    description:
      'Dimensional filters (analytics contract), e.g. channel_group=ads. AND-ed at query time.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  filters?: FilterDto[];

  @ApiProperty({ required: false, enum: ['session', 'visitor'] })
  @IsOptional()
  @IsIn(['session', 'visitor'])
  unit?: 'session' | 'visitor';

  @ApiProperty({ required: false, description: 'Override the funnel default window.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7_776_000)
  window_seconds?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;
}
