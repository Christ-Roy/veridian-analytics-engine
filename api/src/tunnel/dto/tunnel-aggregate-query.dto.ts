import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TunnelAggregateQueryDto {
  @ApiProperty({ description: 'Workspace to aggregate (scoped by the API key).' })
  @IsString()
  workspace_id: string;

  @ApiProperty({
    required: false,
    description: 'Window start (ISO). Defaults to until - 48h (bridge sweep window).',
  })
  @IsOptional()
  @IsDateString()
  since?: string;

  @ApiProperty({
    required: false,
    description: 'Window end (ISO). Defaults to now.',
  })
  @IsOptional()
  @IsDateString()
  until?: string;
}
