/**
 * Forms feature — barrel export (B1).
 *
 * Module isolé qui porte la chaîne `FormSubmission → Lead → LeadSession`
 * depuis veridian-analytics legacy. Câblé dans app.ts via
 * `registerFormsRoutes(app, { prisma, requireAdmin, staminadsUrl })`.
 */

export {
  ingestFormSubmission,
  SiteKeyNotFoundError,
  type IngestContext,
  type IngestDeps,
  type IngestResult,
} from "./ingest.js";

export {
  listSubmissions,
  getLeadDetails,
  TenantNotFoundError,
  LeadNotFoundError,
} from "./query.js";

export {
  IngestFormSchema,
  ListSubmissionsFiltersSchema,
  type IngestFormPayload,
  type ListSubmissionsFilters,
  type ListSubmissionsResult,
  type SubmissionListItem,
  type LeadDetails,
} from "./types.js";

export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
} from "./rate-limit.js";

export {
  pushFormSubmissionEvent,
  type PushFormEventArgs,
  type PushFormEventResult,
} from "./staminads-event.js";

export {
  sanitizePayload,
  sanitizeString,
  extractLeadFields,
} from "./sanitize.js";

export { registerFormsRoutes, type FormsRoutesDeps } from "./routes.js";
