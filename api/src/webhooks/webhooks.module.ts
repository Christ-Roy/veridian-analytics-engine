import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersModule } from '../members/members.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookCrypto } from './webhook-crypto';
import { WebhookSsrfGuard } from './webhook-ssrf-guard';
import { WebhookFilterEngine } from './webhook-filter-engine';
import { WebhookTransformEngine } from './webhook-transform-engine';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.service';

@Module({
  imports: [DatabaseModule, forwardRef(() => MembersModule)],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookCrypto,
    WebhookSsrfGuard,
    WebhookFilterEngine,
    WebhookTransformEngine,
    WebhookDispatcherService,
    WebhookDeliveryWorker,
  ],
  exports: [WebhooksService, WebhookDispatcherService],
})
export class WebhooksModule {}
