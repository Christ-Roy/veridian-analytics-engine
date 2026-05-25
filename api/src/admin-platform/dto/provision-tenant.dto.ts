import {
  IsEmail,
  IsString,
  IsUrl,
  IsOptional,
  IsArray,
  ValidateNested,
  Length,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  @Length(8, 20)
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
   * IANA timezone (default: Europe/Paris if omitted).
   */
  @IsOptional()
  @IsString()
  timezone?: string;

  /**
   * ISO 4217 currency code (default: EUR if omitted).
   */
  @IsOptional()
  @IsString()
  @Length(3, 3)
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
