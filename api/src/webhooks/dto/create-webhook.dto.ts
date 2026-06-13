import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { FilterOp, WebhookAuthType } from '../entities/webhook-definition.entity';

const FILTER_OPS: FilterOp[] = ['equals', 'matches', 'in', 'gt', 'lt'];
const AUTH_TYPES: WebhookAuthType[] = ['none', 'bearer', 'basic', 'hmac'];

export class WebhookAuthDto {
  @ApiProperty({ enum: AUTH_TYPES })
  @IsString()
  @IsIn(AUTH_TYPES)
  type: WebhookAuthType;

  /** Bearer / Basic / HMAC secret. Stored encrypted, never returned. */
  @ApiProperty({ required: false, description: 'Secret stored encrypted; never returned in GET responses.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  token?: string;
}

export class WebhookFilterDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  field: string;

  @ApiProperty({ enum: FILTER_OPS })
  @IsString()
  @IsIn(FILTER_OPS)
  op: FilterOp;

  @ApiProperty({
    description:
      'Filter target value. String/number for equals/matches/gt/lt; array for "in".',
  })
  value: unknown;
}

export class WebhookTransformDto {
  @ApiProperty({ enum: ['passthrough', 'template', 'twenty'] })
  @IsString()
  @IsIn(['passthrough', 'template', 'twenty'])
  type: 'passthrough' | 'template' | 'twenty';

  /** Handlebars template (only used when type='template'). */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64_000)
  template?: string;

  /**
   * Native Twenty destination only (type='twenty'): log mutations instead of
   * sending them (gate à blanc). Reads (Person resolution) stay real.
   */
  @ApiProperty({
    required: false,
    description: 'Twenty destination dry-run (mutations logged, reads real).',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

export class WebhookRetryDto {
  @ApiProperty({ minimum: 1, maximum: 10 })
  @IsInt()
  max_attempts: number;

  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  backoff_ms: number[];
}

export class CreateWebhookDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ format: 'uri' })
  @IsString()
  @IsUrl(
    { require_protocol: true, require_tld: false, protocols: ['http', 'https'] },
    { message: 'url must be a valid http(s) URL' },
  )
  @MaxLength(2048)
  url: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ type: WebhookAuthDto })
  @ValidateNested()
  @Type(() => WebhookAuthDto)
  auth: WebhookAuthDto;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  events: string[];

  @ApiProperty({ type: [WebhookFilterDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => WebhookFilterDto)
  filters?: WebhookFilterDto[];

  @ApiProperty({ type: WebhookTransformDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookTransformDto)
  transform?: WebhookTransformDto;

  @ApiProperty({ type: WebhookRetryDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookRetryDto)
  retry?: WebhookRetryDto;
}

export class UpdateWebhookDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsUrl(
    { require_protocol: true, require_tld: false, protocols: ['http', 'https'] },
    { message: 'url must be a valid http(s) URL' },
  )
  @MaxLength(2048)
  url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ required: false, type: WebhookAuthDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookAuthDto)
  auth?: WebhookAuthDto;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  events?: string[];

  @ApiProperty({ required: false, type: [WebhookFilterDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => WebhookFilterDto)
  filters?: WebhookFilterDto[];

  @ApiProperty({ required: false, type: WebhookTransformDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookTransformDto)
  transform?: WebhookTransformDto;

  @ApiProperty({ required: false, type: WebhookRetryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookRetryDto)
  retry?: WebhookRetryDto;
}

export class DeleteWebhookDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  id: string;
}

export class GetWebhookDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  id: string;
}

export class ListWebhooksDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class TestWebhookDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty({ required: false, description: 'Custom event payload to send. Otherwise a synthetic event is used.' })
  @IsOptional()
  @IsObject()
  event?: Record<string, unknown>;
}

export class ListDeliveriesDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  webhook_id?: string;

  @ApiProperty({ required: false, enum: ['pending', 'success', 'failed', 'retrying', 'gave_up'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false, default: 50 })
  @IsOptional()
  @IsInt()
  limit?: number;
}

export class RetryDeliveryDto {
  @ApiProperty()
  @IsString()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  delivery_id: string;
}
