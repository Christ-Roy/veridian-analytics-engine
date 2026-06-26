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
  MinLength,
  MaxLength,
  Matches,
  ArrayMinSize,
  ArrayMaxSize,
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

/** One step of a persisted named funnel (VAGUE 2). */
export class WorkspaceFunnelStepDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  goal_name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

/**
 * One named, persisted funnel for a workspace (VAGUE 2 customisation). The
 * workspace-layer persistence contract for `settings.funnels` — the admin
 * M2M funnels DTOs reuse this shape (same pattern as CrmMappingDto). 2..8
 * ordered steps; `name` is a slug used to execute the funnel by name.
 */
export class WorkspaceFunnelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/, {
    message:
      'name must be a slug: lowercase letters/digits/_/- , starting with a letter or digit',
  })
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceFunnelStepDto)
  steps: WorkspaceFunnelStepDto[];

  @IsOptional()
  @IsIn(['session', 'visitor'])
  default_unit?: 'session' | 'visitor';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(7_776_000)
  default_window_seconds?: number;
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkspaceFunnelDto)
  funnels?: WorkspaceFunnelDto[];
}

export class UpdateWorkspaceDto {
  // Strictly validated (same rule as CreateWorkspaceDto) — defends against
  // SQL injection on the ClickHouse system DB, since `id` reaches raw
  // `ALTER TABLE … WHERE id = '…'` statements in WorkspacesService.delete().
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'ID must start with a letter and contain only lowercase letters, numbers, and underscores',
  })
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
