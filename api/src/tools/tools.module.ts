import { Module } from '@nestjs/common';
import { SsrfGuard } from '../common/ssrf-guard';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

@Module({
  controllers: [ToolsController],
  providers: [ToolsService, SsrfGuard],
})
export class ToolsModule {}
