import { createHash } from 'crypto';

/**
 * Deterministic UUIDv5 (RFC 4122 §4.3) using Node's native crypto — no extra
 * dependency (PATTERNS-WEBHOOKS: don't add a lib when crypto suffices).
 *
 * Why we need this (task #9 — idempotence / exactly-once):
 * Twenty's POST /rest/batch/timelineActivities does NOT deduplicate identical
 * payloads server-side. Without a client-supplied id, replaying the same
 * tracked event creates a DUPLICATE timeline activity. Twenty DOES accept a
 * client-provided `id`; supplying a DETERMINISTIC id = f(event_id, name) makes
 * a replay land on the same row → Twenty no-ops/409 → exactly-once with NO
 * dedup store on the engine side. Cf SPEC-BRIDGE §6.1 + DoD §6.4.
 *
 * UUIDv5 = SHA-1(namespace_bytes ++ name) with version/variant bits set.
 */

/**
 * Fixed namespace for Veridian Twenty timeline activities. A random-but-stable
 * UUID — changing it would re-key every activity, so it must never change.
 */
const TIMELINE_NAMESPACE = 'b7e3c1a4-9f2d-5e6b-8c0a-1d2e3f405162';

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** Format 16 bytes as a canonical lowercase UUID string. */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Compute a deterministic UUIDv5 from a name within the timeline namespace.
 * Same name → same UUID, forever.
 */
export function uuidv5(name: string): string {
  const nsBytes = uuidToBytes(TIMELINE_NAMESPACE);
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  // Take the first 16 bytes of the 20-byte SHA-1 digest.
  const bytes = hash.subarray(0, 16);
  // Set version (5) in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant (RFC 4122) in the two high bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/**
 * Deterministic id for a Twenty timeline activity. Keyed by the underlying
 * tracked event id + the timeline activity name so that:
 *   - the SAME (event, milestone) always yields the SAME activity id (replay-safe)
 *   - two DIFFERENT milestones derived from one event (rare) stay distinct.
 */
export function deterministicTimelineId(eventId: string, name: string): string {
  return uuidv5(`timeline:${eventId}:${name}`);
}
