import {
  IsEmail,
  IsString,
  IsUrl,
  IsOptional,
  IsArray,
  ValidateNested,
  Length,
  IsIn,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';
import { IsIso4217Currency } from '../../common/validators/currency.validator';
import { IsE164 } from '../../common/validators/e164.validator';

/** Workspace id slug regex — must match CreateWorkspaceDto (`^[a-z][a-z0-9_]*$`). */
export const WORKSPACE_ID_REGEX = /^[a-z][a-z0-9_]*$/;

/**
 * Phone source dimension — tracks WHERE a phone call lead originated.
 * Used by the bridge to attribute calls to acquisition channels.
 */
export type PhoneSource =
  | 'seo'
  | 'ads'
  | 'direct'
  | 'email'
  | 'social'
  | 'print'
  | 'other';

export const PHONE_SOURCES: PhoneSource[] = [
  'seo',
  'ads',
  'direct',
  'email',
  'social',
  'print',
  'other',
];

export class PhoneNumberDto {
  /**
   * Phone number in E.164 format (e.g. +33123456789).
   * Validated permissively — full E.164 strict check happens at bridge level
   * where Telnyx/OVH integration normalizes the value.
   */
  @IsString()
  @IsE164()
  e164: string;

  @IsString()
  @IsIn(PHONE_SOURCES)
  source: PhoneSource;
}

export class ProvisionTenantDto {
  /**
   * Email of the owner user to create (or look up if already exists — see service docstring).
   */
  @IsEmail()
  email: string;

  /**
   * Site URL (must be HTTPS for production tenants). Used as workspace.website.
   */
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  siteUrl: string;

  /**
   * Human-readable workspace name (e.g. "Boulangerie Dupont").
   * Used both as workspace.name and to derive the workspace_id slug.
   */
  @IsString()
  @Length(2, 100)
  name: string;

  /**
   * OPTIONAL explicit workspace_id (e.g. legacy id adopted during the D2
   * migration of existing clients). When provided, it is used verbatim
   * instead of slugifying `name` — so a migrated workspace keeps its legacy
   * id.
   *
   * VALIDATION (here, at the DTO layer — not the service): the id must match
   * the workspace slug regex `^[a-z][a-z0-9_]*$` and be 2..50 chars. A malformed
   * id is an INPUT error → 400 VALIDATION_ERROR, NOT a 409. The 409
   * (WORKSPACE_ALREADY_EXISTS) is reserved EXCLUSIVELY for the genuine conflict
   * "this id is already taken" (checked in the service). When omitted, the id is
   * slugified from `name` (default flow).
   */
  @IsOptional()
  @IsString()
  @Length(2, 50)
  @Matches(WORKSPACE_ID_REGEX, {
    message:
      'workspace_id must match ^[a-z][a-z0-9_]*$ (lowercase letter, then lowercase letters/digits/underscores)',
  })
  workspace_id?: string;

  /**
   * IANA timezone (default: Europe/Paris if omitted).
   */
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  /**
   * ISO 4217 currency code (default: EUR if omitted). Validated against the
   * closed ISO-4217 list (same as workspaces.updateSettings) so a bogus code
   * (e.g. "BANANABUCKS") never reaches WorkspacesService.create and later
   * breaks `Intl.NumberFormat` in the console.
   */
  @IsOptional()
  @IsIso4217Currency()
  currency?: string;

  /**
   * Optional array of phone numbers to attach as call sources.
   * Forwarded to bridge service if BRIDGE_URL + BRIDGE_ADMIN_API_KEY configured.
   * Otherwise queued / skipped (see service.ts for compensation logic).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PhoneNumberDto)
  phoneNumbers?: PhoneNumberDto[];
}
