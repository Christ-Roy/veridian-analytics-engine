import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { WorkspaceAuthGuard } from '../common/guards/workspace.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { WebhooksService } from './webhooks.service';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.service';
import {
  CreateWebhookDto,
  DeleteWebhookDto,
  GetWebhookDto,
  ListDeliveriesDto,
  ListWebhooksDto,
  RetryDeliveryDto,
  TestWebhookDto,
  UpdateWebhookDto,
} from './dto/create-webhook.dto';
import { toClickHouseDateTime } from '../common/utils/datetime.util';

@ApiTags('webhooks')
@ApiSecurity('api-key')
@ApiSecurity('jwt-auth')
@Controller('api')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly worker: WebhookDeliveryWorker,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────

  @Post('webhooks.create')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.write')
  @ApiOperation({ summary: 'Create a webhook destination for a workspace.' })
  async create(@Body() dto: CreateWebhookDto) {
    return this.webhooks.create(dto);
  }

  @Get('webhooks.list')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.read')
  @ApiOperation({ summary: 'List webhook destinations for a workspace.' })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  @ApiQuery({ name: 'active', type: Boolean, required: false })
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('active') active?: string,
  ) {
    const dto: ListWebhooksDto = { workspace_id: workspaceId };
    if (active === 'true') dto.active = true;
    else if (active === 'false') dto.active = false;
    return this.webhooks.list(dto);
  }

  @Get('webhooks.get')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.read')
  @ApiOperation({ summary: 'Get a webhook destination by id.' })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  @ApiQuery({ name: 'id', type: String, required: true })
  async get(
    @Query('workspace_id') workspaceId: string,
    @Query('id') id: string,
  ) {
    return this.webhooks.get({ workspace_id: workspaceId, id });
  }

  @Post('webhooks.update')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.write')
  @ApiOperation({ summary: 'Update a webhook destination.' })
  async update(@Body() dto: UpdateWebhookDto) {
    return this.webhooks.update(dto);
  }

  @Post('webhooks.delete')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.delete')
  @ApiOperation({ summary: 'Soft-delete a webhook destination.' })
  async delete(@Body() dto: DeleteWebhookDto) {
    return this.webhooks.softDelete(dto);
  }

  // ─── Test (synchronous) ──────────────────────────────────────────

  @Post('webhooks.test')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.test')
  @ApiOperation({
    summary:
      'Trigger a synchronous test delivery to the webhook destination. Returns the result inline.',
  })
  async test(@Body() dto: TestWebhookDto) {
    const webhook = await this.webhooks.findById(dto.workspace_id, dto.id);
    if (!webhook) {
      throw new NotFoundException({
        code: 'WEBHOOK_NOT_FOUND',
        message: `Webhook ${dto.id} not found.`,
      });
    }
    const synthetic =
      dto.event ?? {
        event_type: 'webhook.test',
        event_id: `test_${Date.now()}`,
        workspace_id: dto.workspace_id,
        path: '/__test__',
        utm: { source: 'webhook-test' },
      };
    const delivery = await this.webhooks.enqueueDelivery(webhook, {
      event_id: String(synthetic.event_id ?? `test_${Date.now()}`),
      event_type: String(synthetic.event_type ?? 'webhook.test'),
      payload: synthetic,
    });
    const result = await this.worker.sendOne(webhook, delivery);
    await this.webhooks.updateDelivery({
      ...delivery,
      status: result.success ? 'success' : 'failed',
      sent_at: toClickHouseDateTime(),
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      response_body: result.response_body,
      error_message: result.error_message,
    });
    return {
      delivery_id: delivery.id,
      success: result.success,
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      response_body: result.response_body,
      error_message: result.error_message,
    };
  }

  // ─── Deliveries ───────────────────────────────────────────────────

  @Get('webhooks.deliveries.list')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.read')
  @ApiOperation({ summary: 'List recent webhook deliveries.' })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  @ApiQuery({ name: 'webhook_id', type: String, required: false })
  @ApiQuery({ name: 'status', type: String, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  async listDeliveries(
    @Query('workspace_id') workspaceId: string,
    @Query('webhook_id') webhookId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const dto: ListDeliveriesDto = {
      workspace_id: workspaceId,
      webhook_id: webhookId,
      status,
      limit: limit ? Math.max(parseInt(limit, 10) || 50, 1) : undefined,
    };
    return this.webhooks.listDeliveries(dto);
  }

  @Post('webhooks.deliveries.retry')
  @HttpCode(200)
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.write')
  @ApiOperation({ summary: 'Manually retry a failed / gave_up delivery.' })
  async retryDelivery(@Body() dto: RetryDeliveryDto) {
    const delivery = await this.webhooks.getDelivery(dto.workspace_id, dto.delivery_id);
    if (!delivery) {
      throw new NotFoundException({
        code: 'DELIVERY_NOT_FOUND',
        message: `Delivery ${dto.delivery_id} not found.`,
      });
    }
    if (delivery.status === 'pending' || delivery.status === 'retrying') {
      throw new BadRequestException({
        code: 'DELIVERY_NOT_RETRIABLE',
        message: 'Delivery is already pending or retrying.',
      });
    }
    await this.webhooks.updateDelivery({
      ...delivery,
      status: 'pending',
      attempt: 1,
      scheduled_at: toClickHouseDateTime(),
      sent_at: null,
      http_status: null,
      latency_ms: null,
      response_body: '',
      error_message: '',
    });
    return { success: true, delivery_id: delivery.id };
  }

  // ─── Events catalogue (V1 — hardcoded) ───────────────────────────

  @Get('webhooks.events')
  @UseGuards(WorkspaceAuthGuard)
  @RequirePermission('webhook.read')
  @ApiOperation({
    summary:
      'List event types a webhook can subscribe to. V1 catalogue — hardcoded.',
  })
  @ApiQuery({ name: 'workspace_id', type: String, required: true })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async events(@Query('workspace_id') _workspaceId: string) {
    return {
      events: [
        { type: 'screen_view', description: 'A page-view tracked by the SDK.' },
        { type: 'goal', description: 'A configured goal was reached.' },
        { type: 'webhook.test', description: 'Synthetic event used by webhooks.test.' },
      ],
    };
  }
}
