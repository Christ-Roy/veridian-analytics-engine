import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  BrandingDto,
  CrmMappingDto,
  DashboardLayoutDto,
  FeaturesDto,
} from '../../workspaces/dto/update-workspace.dto';

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
  @ApiProperty({ type: DashboardLayoutDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DashboardLayoutDto)
  dashboard_layout: DashboardLayoutDto;
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
