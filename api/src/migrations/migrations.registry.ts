import { MajorMigration } from './migration.interface';
import { V4ResetMigration } from './v4-reset-migration';
import { V5SubscriptionsMigration } from './v5-subscriptions-migration';
import { V6UserIdMigration } from './v6-user-id-migration';
import { V7WebhooksMigration } from './v7-webhooks-migration';
import { V8VoipMigration } from './v8-voip-migration';
import { V9GscMigration } from './v9-gsc-migration';
import { V10VisitorIdMigration } from './v10-visitor-id-migration';

/**
 * Registry of all major migrations.
 * Add new migrations here in version order.
 */
export const MIGRATIONS: MajorMigration[] = [
  V4ResetMigration,
  V5SubscriptionsMigration,
  V6UserIdMigration,
  V7WebhooksMigration,
  V8VoipMigration,
  V9GscMigration,
  V10VisitorIdMigration,
];
