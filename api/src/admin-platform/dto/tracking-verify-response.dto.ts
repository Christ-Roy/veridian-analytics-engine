import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of the synthetic dry-run ingestion: did an event traverse the WHOLE
 * chain (validation → buffer → ClickHouse events table → MV fan-out →
 * requeryable) and how long did the round trip take? The synthetic event is
 * anchored at a far-past sentinel timestamp (invisible to every date-bounded
 * report) and purged after the probe — see AdminPlatformService.verifyTracking.
 */
export class TrackingVerifyIngestion {
  @ApiProperty({
    description:
      'True if the synthetic event was ingested through the real pipeline ' +
      'and read back from ClickHouse. The proof the tracker chain works.',
  })
  ok: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Round-trip latency (ms) between injection and the event being ' +
      'requeryable. null when ingestion failed.',
  })
  round_trip_ms: number | null;

  @ApiProperty({ description: 'Human-readable outcome of the ingestion probe.' })
  detail: string;
}

/** Snippet audit — only present when site_url was supplied. */
export class TrackingVerifySnippet {
  @ApiProperty({ description: 'Always true when this block is present.' })
  checked: boolean;

  @ApiProperty({
    description: 'True if a Veridian/staminads tracker <script> was found.',
  })
  present: boolean;

  @ApiProperty({
    description:
      'True if the script src points at /sdk/v1/tracker.js (the route that ' +
      'serves the real bundle), NOT the bare /tracker.js path which falls ' +
      'through to the SPA console HTML and tracks nothing.',
  })
  src_correct: boolean;

  @ApiProperty({
    description: 'True if data-workspace-id matches the requested workspace.',
  })
  workspace_id_match: boolean;

  @ApiProperty({ description: 'Human-readable outcome of the snippet probe.' })
  detail: string;
}

/** Real (non-synthetic) tracking liveness — reuses workspaces.status probe. */
export class TrackingVerifyRealTracking {
  @ApiProperty({ description: 'Real sessions recorded in the last 30 days.' })
  sessions_30d: number;

  @ApiProperty({
    description: 'True if a real session was recorded in the last 30 minutes.',
  })
  live: boolean;
}

export type TrackingVerifyVerdict =
  | 'ok'
  | 'ingestion_failed'
  | 'snippet_missing'
  | 'snippet_misconfigured'
  | 'workspace_not_found';

/**
 * Response of POST tracking.verify (M2M). The single call an IA makes after
 * installing the snippet to answer "is the tracking actually working?".
 */
export class TrackingVerifyResponseDto {
  @ApiProperty()
  workspace_id: string;

  @ApiProperty({ description: 'False when the workspace does not exist.' })
  workspace_exists: boolean;

  @ApiProperty({
    type: TrackingVerifyIngestion,
    description: 'Synthetic dry-run ingestion round-trip result.',
  })
  ingestion: TrackingVerifyIngestion;

  @ApiProperty({
    type: TrackingVerifySnippet,
    nullable: true,
    description: 'Snippet audit. null/absent when no site_url was supplied.',
  })
  snippet: TrackingVerifySnippet | null;

  @ApiProperty({
    type: TrackingVerifyRealTracking,
    description: 'Real tracking liveness (untouched by the synthetic probe).',
  })
  real_tracking: TrackingVerifyRealTracking;

  @ApiProperty({
    enum: [
      'ok',
      'ingestion_failed',
      'snippet_missing',
      'snippet_misconfigured',
      'workspace_not_found',
    ],
    description: 'Single-word verdict an IA can branch on.',
  })
  verdict: TrackingVerifyVerdict;
}
