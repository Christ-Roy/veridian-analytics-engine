import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MembersModule } from '../members/members.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookCrypto } from './webhook-crypto';
import { SsrfGuard } from '../common/ssrf-guard';
import { WebhookFilterEngine } from './webhook-filter-engine';
import { WebhookTransformEngine } from './webhook-transform-engine';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.service';
import { TwentyEventMapper } from './connectors/twenty-event-mapper';
import { TwentyConnectorService } from './connectors/twenty-connector.service';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => MembersModule),
    forwardRef(() => WorkspacesModule),
  ],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookCrypto,
    SsrfGuard,
    WebhookFilterEngine,
    WebhookTransformEngine,
    WebhookDispatcherService,
    WebhookDeliveryWorker,
    TwentyEventMapper,
    TwentyConnectorService,
  ],
  exports: [WebhooksService, WebhookDispatcherService, WebhookDeliveryWorker],
})
export class WebhooksModule {}
