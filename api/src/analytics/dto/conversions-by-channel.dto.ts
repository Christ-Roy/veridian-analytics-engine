import {
  IsString,
  IsArray,
  IsOptional,
  ValidateNested,
  Validate,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DateRangeDto, DateRangeValidator } from './analytics-query.dto';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';

/**
 * Taux de création/conversion par app × canal. Pour chaque (channel_group, app)
 * : nombre de conversions (sessions ayant déclenché un des `conversion_goals`)
 * et taux vs les sessions du même canal.
 */
export class ConversionsByChannelDto {
  @IsString()
  workspace_id: string;

  @Validate(DateRangeValidator)
  @ValidateNested()
  @Type(() => DateRangeDto)
  dateRange: DateRangeDto;

  /**
   * Objectifs comptés comme "conversion". Défaut = ['signup','app_started']
   * (les goals d'inscription qui portent `properties['app']`).
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  conversion_goals?: string[];

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;
}
