import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  BrandingDto,
  CrmMappingDto,
  FeaturesDto,
} from '../../workspaces/dto/update-workspace.dto';
import { IsKnownDashboardWidget } from '../../common/validators/dashboard-widget.validator';
import {
  WIDGET_KINDS,
  WIDGET_GRANULARITIES,
  WIDGET_FILTER_OPERATORS,
} from '../../common/widget-catalog';
import { DateRangeDto } from '../../analytics/dto/analytics-query.dto';

/**
 * One filter on a custom widget's underlying group-by. Shape mirrors the native
 * `FilterDto` but is restricted to widget-safe dimensions + a curated operator
 * set (the deep whitelist/coherence check happens in the service via
 * `validateWidgetsArray`, which produces the canonical 400 reused at both
 * setLayout and widgetData compile time).
 */
export class WidgetFilterDto {
  @ApiProperty({ description: 'Widget-safe dimension to filter on.' })
  @IsString()
  @IsNotEmpty()
  dimension: string;

  @ApiProperty({ enum: WIDGET_FILTER_OPERATORS })
  @IsString()
  @IsIn(WIDGET_FILTER_OPERATORS as unknown as string[])
  operator: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  values?: (string | number | null)[];
}

/**
 * A custom dashboard widget = a DESCRIPTION of a group-by resolved by the
 * existing analytics query-builder. Stored in `dashboard_layout.widgets[]` next
 * to the native order/hidden lists (zero migration). The 8 native widgets are
 * untouched; this only ADDS workspace-defined widgets.
 *
 * Coherence rules (enforced in the service at persist time, 400 if violated):
 *  - dimension_table REQUIRES `dimension`, metric_card FORBIDS it
 *  - time_series REQUIRES `granularity`
 *  - metric ∈ widget-safe whitelist; dimension ∈ widget-safe whitelist
 *  - id unique across the array + valid slug
 *
 * The class-validator decorators here cover the cheap shape checks; the
 * cross-field + whitelist logic lives in `validateWidgetsArray` so it can also
 * defensively re-run when compiling the widget at widgetData time.
 */
export class WidgetConfigDto {
  @ApiProperty({ description: 'Unique slug id within the layout.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  @ApiProperty({ enum: WIDGET_KINDS })
  @IsString()
  @IsIn(WIDGET_KINDS as unknown as string[])
  kind: string;

  @ApiProperty({ description: 'Display title.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @ApiProperty({ description: 'Widget-safe metric key.' })
  @IsString()
  @IsNotEmpty()
  metric: string;

  @ApiProperty({
    required: false,
    enum: ['sessions', 'pages', 'goals'],
    description: 'Analytics table (default sessions).',
  })
  @IsOptional()
  @IsString()
  @IsIn(['sessions', 'pages', 'goals'])
  table?: 'sessions' | 'pages' | 'goals';

  @ApiProperty({
    required: false,
    description: 'Widget-safe dimension (required for dimension_table).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dimension?: string;

  @ApiProperty({
    required: false,
    enum: WIDGET_GRANULARITIES,
    description: 'Time bucket (required for time_series).',
  })
  @IsOptional()
  @IsString()
  @IsIn(WIDGET_GRANULARITIES as unknown as string[])
  granularity?: string;

  @ApiProperty({ required: false, type: [WidgetFilterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WidgetFilterDto)
  filters?: WidgetFilterDto[];

  @ApiProperty({
    required: false,
    description: 'Row cap for dimension_table (1-1000, default 10).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/**
 * M2M dashboard layout body. Stricter sibling of the console-shared
 * `DashboardLayoutDto`.
 *
 * `hidden_widgets` may only reference a NATIVE widget key (you hide a native
 * widget; a custom widget you simply omit from `widgets[]` / `order`), so it
 * keeps the strict `IsKnownDashboardWidget` gate — a typo is a 400 instead of a
 * silently-broken layout (ticket 2026-06-24-validation-currency-e164-layout-trous
 * §3).
 *
 * `order` may reference a native key OR a custom `widget.id` (VAGUE 2), so the
 * strict native-only decorator is dropped here and the combined validation
 * (native keys ∪ ids of the widgets being persisted) runs in the SERVICE, where
 * the full layout is known. A `order` entry that names neither → 400, never
 * persisted.
 *
 * FULL-REPLACE semantics: the engine merges this object over the existing
 * `dashboard_layout`, but each FIELD is replaced wholesale. Sending only
 * `order` leaves `hidden_widgets`/`widgets` untouched. To clear a field, send it
 * as an empty array.
 */
export class DashboardLayoutM2MDto {
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Native widgets to hide (full-replace). Each must be a known native widget key.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsKnownDashboardWidget({ each: true })
  hidden_widgets?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Widget display order (full-replace, not appended). Each entry must be a native widget key OR a custom widget.id.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  order?: string[];

  @ApiProperty({
    required: false,
    type: [WidgetConfigDto],
    description:
      'Custom dashboard widgets (full-replace). Each is compiled into an analytics group-by and resolved by the native query-builder. Strictly validated at persist time (whitelist + kind coherence + unique id).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WidgetConfigDto)
  widgets?: WidgetConfigDto[];
}

/**
 * Dedicated M2M bodies for the per-workspace customization surface (white-label
 * + multi-industrie). These are thin, single-purpose alternatives to the
 * catch-all `workspaces.updateSettings` so the provisioning agent (and later the
 * Hub) has one explicit verb per concern. All keyed on `workspace_id`.
 */

class WorkspaceKeyedDto {
  @ApiProperty({ description: 'Target workspace id.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}

/** POST /workspaces.setBranding — accent color (logo/name via updateSettings). */
export class SetBrandingDto extends WorkspaceKeyedDto {
  @ApiProperty({ type: BrandingDto })
  @IsObject()
  @ValidateNested()
  @Type(() => BrandingDto)
  branding: BrandingDto;
}

/** POST /workspaces.setFeatures — subscribed modules → tab visibility. */
export class SetFeaturesDto extends WorkspaceKeyedDto {
  @ApiProperty({ type: FeaturesDto })
  @IsObject()
  @ValidateNested()
  @Type(() => FeaturesDto)
  features: FeaturesDto;
}

/** POST /workspaces.setLayout — native dashboard widget order/visibility. */
export class SetLayoutDto extends WorkspaceKeyedDto {
  @ApiProperty({ type: DashboardLayoutM2MDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DashboardLayoutM2MDto)
  dashboard_layout: DashboardLayoutM2MDto;
}

/** POST /crm.setMapping — configurable analytics→CRM semantics (N4 + S4). */
export class SetCrmMappingDto extends WorkspaceKeyedDto {
  @ApiProperty({ type: CrmMappingDto })
  @IsObject()
  @ValidateNested()
  @Type(() => CrmMappingDto)
  crm_mapping: CrmMappingDto;
}

/** POST /crm.getMapping — read the current mapping (audit / IA introspection). */
export class GetCrmMappingDto extends WorkspaceKeyedDto {}

/** POST /workspaces.getCustomization — read branding+features+layout+crm in one call. */
export class GetCustomizationDto extends WorkspaceKeyedDto {
  @ApiProperty({
    required: false,
    description: 'Reserved for future field selection.',
  })
  @IsOptional()
  @IsString()
  _?: string;
}

/**
 * POST /analytics.widgetData — resolve ONE persisted custom widget's data.
 *
 * The caller (console A2 front) passes only `{workspace_id, widget_id,
 * dateRange, timezone?}`. The engine reads the widget-config persisted in
 * `dashboard_layout.widgets[]`, compiles it into the canonical
 * AnalyticsQueryDto (metric/dimension/granularity/filters come from the STORED
 * config, NOT the request — the front cannot smuggle a metric/dimension here),
 * delegates to `analyticsService.query()`, and returns
 * `{widget_id, kind, title, data}`. Unknown widget_id → 404.
 */
export class WidgetDataDto extends WorkspaceKeyedDto {
  @ApiProperty({ description: 'Id of the persisted custom widget to resolve.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  widget_id: string;

  @ApiProperty({
    type: DateRangeDto,
    description: 'Date range (preset OR start+end). Same shape as analytics.query.',
  })
  @ValidateNested()
  @Type(() => DateRangeDto)
  dateRange: DateRangeDto;

  @ApiProperty({
    required: false,
    description: 'IANA timezone for granularity bucketing (default workspace tz).',
  })
  @IsOptional()
  @IsString()
  timezone?: string;
}
