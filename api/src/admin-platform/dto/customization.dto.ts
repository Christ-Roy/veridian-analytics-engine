import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
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

/**
 * M2M dashboard layout body. Stricter sibling of the console-shared
 * `DashboardLayoutDto`: every widget key in `order` / `hidden_widgets` is
 * validated against the closed list of native widgets (IsKnownDashboardWidget),
 * so a typo'd key is a 400 instead of a silently-broken layout (ticket
 * 2026-06-24-validation-currency-e164-layout-trous §3). The shared DTO stays
 * permissive for the console path; the M2M surface is the strict one.
 *
 * FULL-REPLACE semantics: the engine merges this object over the existing
 * `dashboard_layout`, but each FIELD is replaced wholesale. Sending only
 * `order` leaves `hidden_widgets` untouched (and vice-versa); sending `order`
 * REPLACES the entire previous order array (it is NOT appended). To clear a
 * field, send it as an empty array.
 */
export class DashboardLayoutM2MDto {
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Widgets to hide (full-replace). Each must be a known native widget key.',
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
      'Widget display order (full-replace, not appended). Each must be a known native widget key.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsKnownDashboardWidget({ each: true })
  order?: string[];
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
