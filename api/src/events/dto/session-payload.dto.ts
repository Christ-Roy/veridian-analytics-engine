import { Type } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  IsObject,
  IsIn,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { IsWithinTimeBounds } from '../../common/validators/time-bounds.validator';
import { IsGreaterThanOrEqual } from '../../common/validators/compare.validator';
import { IsBoundedStringMap } from '../../common/validators/bounded-string-map.validator';

// Constants
export const MAX_ACTIONS = 1000;
export const MAX_PATH_LENGTH = 2048;
export const MAX_GOAL_NAME_LENGTH = 100;
export const TIMESTAMP_BOUNDS_HOURS = 24;

// === Action DTOs ===

export class PageviewActionDto {
  @IsIn(['pageview'])
  type: 'pageview';

  @IsString()
  @MaxLength(MAX_PATH_LENGTH)
  path: string;

  @IsNumber()
  @Min(1)
  page_number: number;

  @IsNumber()
  @Min(0)
  duration: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  scroll: number;

  @IsNumber()
  entered_at: number;

  @IsNumber()
  @IsGreaterThanOrEqual('entered_at', {
    message: 'exited_at must be greater than or equal to entered_at',
  })
  exited_at: number;
}

export class GoalActionDto {
  @IsIn(['goal'])
  type: 'goal';

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_GOAL_NAME_LENGTH)
  name: string;

  @IsString()
  @MaxLength(MAX_PATH_LENGTH)
  path: string;

  @IsNumber()
  @Min(1)
  page_number: number;

  @IsNumber()
  timestamp: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsObject()
  @IsBoundedStringMap()
  properties?: Record<string, string>;
}

// === Session Attributes DTO ===

export class SessionAttributesDto {
  @IsOptional()
  @IsString()
  referrer?: string;

  @IsString()
  landing_page: string;

  @IsOptional()
  @IsString()
  utm_source?: string;

  @IsOptional()
  @IsString()
  utm_medium?: string;

  @IsOptional()
  @IsString()
  utm_campaign?: string;

  @IsOptional()
  @IsString()
  utm_term?: string;

  @IsOptional()
  @IsString()
  utm_content?: string;

  @IsOptional()
  @IsString()
  utm_id?: string;

  @IsOptional()
  @IsString()
  utm_id_from?: string;

  @IsOptional()
  @IsNumber()
  screen_width?: number;

  @IsOptional()
  @IsNumber()
  screen_height?: number;

  @IsOptional()
  @IsNumber()
  viewport_width?: number;

  @IsOptional()
  @IsNumber()
  viewport_height?: number;

  @IsOptional()
  @IsString()
  device?: string;

  @IsOptional()
  @IsString()
  browser?: string;

  @IsOptional()
  @IsString()
  browser_type?: string;

  @IsOptional()
  @IsString()
  os?: string;

  @IsOptional()
  @IsString()
  user_agent?: string;

  @IsOptional()
  @IsString()
  connection_type?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  /**
   * Lightweight browser fingerprint from the SDK. Combined SERVER-SIDE with the
   * captured client IP to distinguish visitors behind a shared company IP (B2B).
   * Capped to avoid abuse — the real fingerprint is a short base36 hash.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  fingerprint?: string;
}

// === Session Payload DTO ===

export class SessionPayloadDto {
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @IsString()
  @IsNotEmpty()
  session_id: string;

  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: PageviewActionDto, name: 'pageview' },
        { value: GoalActionDto, name: 'goal' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  actions: (PageviewActionDto | GoalActionDto)[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SessionAttributesDto)
  attributes?: SessionAttributesDto;

  @IsNumber()
  @IsWithinTimeBounds(TIMESTAMP_BOUNDS_HOURS, 'both')
  created_at: number;

  @IsNumber()
  @IsWithinTimeBounds(TIMESTAMP_BOUNDS_HOURS, 'both')
  updated_at: number;

  @IsOptional()
  @IsString()
  sdk_version?: string;

  @IsOptional()
  @IsNumber()
  sent_at?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  user_id?: string | null;

  /**
   * Stable, long-lived visitor identifier (B2B). Top-level alongside user_id —
   * it's an identity, not a device attribute. The handler writes it on every
   * event row so `uniqExact(visitor_id)` yields the real unique-visitor count.
   * NOTE: the client IP is captured SERVER-SIDE (@ClientIp), never trusted from
   * the payload.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  visitor_id?: string;

  @IsOptional()
  @IsObject()
  @IsBoundedStringMap()
  dimensions?: Record<string, string>;
}

// === Type Guards ===

export type Action = PageviewActionDto | GoalActionDto;

export function isPageviewAction(action: Action): action is PageviewActionDto {
  return action.type === 'pageview';
}

export function isGoalAction(action: Action): action is GoalActionDto {
  return action.type === 'goal';
}
