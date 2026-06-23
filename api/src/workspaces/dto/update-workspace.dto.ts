import {
  IsOptional,
  IsString,
  IsUrl,
  IsEmail,
  IsArray,
  IsObject,
  IsNumber,
  IsBoolean,
  IsIn,
  IsDateString,
  Min,
  Max,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FilterDefinition } from '../../filters/entities/filter.entity';
import { Integration } from '../entities/integration.entity';
import type { WorkspaceStatus } from '../entities/workspace.entity';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';

export class AnnotationDto {
  @IsString()
  id: string;

  @IsDateString()
  date: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
  time: string;

  @IsString()
  timezone: string;

  @IsString()
  @MaxLength(100)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string;
}

export class SmtpSettingsUpdateDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  @MaxLength(255)
  host: string;

  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  password_encrypted?: string;

  @IsString()
  @MaxLength(100)
  from_name: string;

  @IsEmail()
  from_email: string;
}

/** Per-client accent color (white-label, N1). */
export class BrandingDto {
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a hex #rrggbb' })
  color?: string;
}

/** Subscribed feature modules → Settings tab visibility (N2). */
export class FeaturesDto {
  @IsOptional()
  @IsBoolean()
  voip?: boolean;

  @IsOptional()
  @IsBoolean()
  gsc?: boolean;

  @IsOptional()
  @IsBoolean()
  connectors?: boolean;
}

/** Native dashboard widget order/visibility per client (N3). */
export class DashboardLayoutDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  hidden_widgets?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  order?: string[];
}

/** One CRM milestone rule (N4 generic engine). */
export class CrmGoalMappingDto {
  @IsString()
  @MaxLength(120)
  match: string;

  @IsString()
  @MaxLength(120)
  timeline_name: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  min_scroll?: number;
}

/** Configurable analytics→CRM semantics per workspace (N4 + S4). */
export class CrmMappingDto {
  @IsOptional()
  @IsIn(['auto', 'email', 'field'])
  identity_resolver?: 'auto' | 'email' | 'field';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_.]+$/, {
    message: 'identity_field must be a Twenty field identifier',
  })
  identity_field?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CrmGoalMappingDto)
  goals?: CrmGoalMappingDto[];

  @IsOptional()
  @IsBoolean()
  map_phone_calls?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  phone_call_timeline_name?: string;
}

export class UpdateWorkspaceSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  timescore_reference?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  bounce_threshold?: number;

  @IsOptional()
  @IsObject()
  custom_dimensions?: Record<string, string>;

  @IsOptional()
  @IsArray()
  filters?: FilterDefinition[];

  @IsOptional()
  @IsArray()
  integrations?: Integration[];

  @IsOptional()
  @IsBoolean()
  geo_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  geo_store_city?: boolean;

  @IsOptional()
  @IsBoolean()
  geo_store_region?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  geo_coordinates_precision?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnnotationDto)
  annotations?: AnnotationDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SmtpSettingsUpdateDto)
  smtp?: SmtpSettingsUpdateDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  @Matches(/^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, {
    each: true,
    message:
      'Each domain must be a valid domain (e.g., example.com or *.example.com)',
  })
  allowed_domains?: string[];

  // ─── White-label / multi-industrie (pilotable M2M) ───────────────────────
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BrandingDto)
  branding?: BrandingDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FeaturesDto)
  features?: FeaturesDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DashboardLayoutDto)
  dashboard_layout?: DashboardLayoutDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CrmMappingDto)
  crm_mapping?: CrmMappingDto;
}

export class UpdateWorkspaceDto {
  @IsString()
  id: string;

  @IsOptional()
  @IsIn(['initializing', 'active', 'inactive', 'error'])
  status?: WorkspaceStatus;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUrl()
  website?: string;

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsUrl()
  logo_url?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateWorkspaceSettingsDto)
  settings?: UpdateWorkspaceSettingsDto;
}
