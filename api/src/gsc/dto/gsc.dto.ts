import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Corps des actions GSC (begin / resync / disconnect). */
export class GscWorkspaceDto {
  @ApiProperty({ description: 'Workspace staminads ciblé.' })
  @IsString()
  workspace_id!: string;
}

/** Query du dashboard : workspace + fenêtre. */
export class GscDashboardQueryDto {
  @ApiProperty()
  @IsString()
  workspace_id!: string;

  @ApiProperty({ required: false, default: 28, minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
