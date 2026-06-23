import { ApiProperty } from '@nestjs/swagger';
import type { PhoneSource } from '../../voip/voip.types';

/** Tracking liveness, derived from recent analytics sessions. */
export class WorkspaceTrackingStatus {
  @ApiProperty({ description: 'True if any session was recorded in the last 30 days.' })
  active: boolean;

  @ApiProperty({ description: 'Sessions (visites) in the last 30 days.' })
  sessions_30d: number;

  @ApiProperty({
    description:
      'Unique visitors (B2B) in the last 30 days — distinct stable visitor_id, a returning visitor counts once.',
  })
  visitors_30d: number;

  @ApiProperty({ description: 'True if any session was recorded in the last 30 minutes (live).' })
  live: boolean;
}

/** GSC connector snapshot (no tokens — public view only). */
export class WorkspaceGscStatus {
  @ApiProperty()
  connected: boolean;

  @ApiProperty({ nullable: true })
  site_url: string | null;

  @ApiProperty({ nullable: true })
  ownership_state: string | null;

  @ApiProperty({ nullable: true })
  last_sync_at: string | null;
}

/** A masked tracked phone number (never the raw credential). */
export class WorkspacePhoneNumberSummary {
  @ApiProperty()
  e164: string;

  @ApiProperty()
  source: PhoneSource;

  @ApiProperty({ nullable: true })
  label: string | null;
}

/** VoIP connector snapshot. */
export class WorkspaceVoipStatus {
  @ApiProperty({ description: 'True if at least one VoIP credential is configured.' })
  configured: boolean;

  @ApiProperty({ description: 'Number of tracked phone numbers.' })
  phone_number_count: number;

  @ApiProperty({ type: [WorkspacePhoneNumberSummary] })
  phone_numbers: WorkspacePhoneNumberSummary[];

  @ApiProperty({
    nullable: true,
    description: 'Most recent successful sync across all credentials (ISO/CH datetime).',
  })
  last_sync_at: string | null;

  @ApiProperty({
    type: [String],
    description: 'Credential kinds configured (voip_ovh, voip_telnyx).',
  })
  credential_kinds: string[];
}

/** A single active webhook destination (no secret). */
export class WorkspaceWebhookSummary {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  url: string;

  @ApiProperty()
  active: boolean;
}

/** Webhooks/connectors snapshot. */
export class WorkspaceWebhooksStatus {
  @ApiProperty({ description: 'Number of active webhook destinations.' })
  active_count: number;

  @ApiProperty({ type: [WorkspaceWebhookSummary] })
  webhooks: WorkspaceWebhookSummary[];
}

/**
 * Consolidated workspace status returned by POST workspaces.status (M2M).
 * Composed from existing domain services; meant to be the single call an IA
 * makes to know "is this tenant fully wired and tracking?".
 */
export class WorkspaceStatusResponseDto {
  @ApiProperty()
  workspace_id: string;

  @ApiProperty({ description: 'False when the workspace does not exist (other fields are null).' })
  exists: boolean;

  @ApiProperty({ nullable: true })
  name: string | null;

  @ApiProperty({ nullable: true, description: 'Workspace lifecycle status.' })
  status: string | null;

  @ApiProperty({ type: WorkspaceTrackingStatus, nullable: true })
  tracking: WorkspaceTrackingStatus | null;

  @ApiProperty({ type: WorkspaceGscStatus, nullable: true })
  gsc: WorkspaceGscStatus | null;

  @ApiProperty({ type: WorkspaceVoipStatus, nullable: true })
  voip: WorkspaceVoipStatus | null;

  @ApiProperty({ type: WorkspaceWebhooksStatus, nullable: true })
  webhooks: WorkspaceWebhooksStatus | null;

  @ApiProperty({
    nullable: true,
    description: 'Ready-to-paste tracker snippet for this workspace.',
  })
  snippet_html: string | null;
}
