/**
 * Forms — types partagés (B1).
 *
 * Schémas Zod + types TS pour le payload du POST /api/ingest/form et la
 * chaîne `FormSubmission → Lead → LeadSession`. Pas de dépendance Prisma
 * ici — les modèles DB sont importés via le client générique côté ingest.
 */

import { z } from "zod";

/**
 * Payload public envoyé par le tracker côté navigateur.
 *
 * - `siteKey` : clé publique posée dans le snippet (Site.siteKey).
 * - `formSlug` : slug stable du formulaire (ex "contact-devis"). Auto-créé
 *   en `FormSchema` si inconnu.
 * - `data` : payload brut du form (Record<string, unknown>). Aucune
 *   eval côté front ; stocké tel quel en JSONB.
 * - `visitorId` / `sessionId` : ids tracker pour rapprocher la session web.
 * - `pageUrl` : URL de la page où le formulaire a été soumis.
 * - `formName` : nom humain optionnel ("Demande de devis"). Utilisé comme
 *   `FormSchema.name` à l'auto-création.
 * - `utm` : utm_source/medium/campaign optionnels pour enrichir la session.
 */
export const IngestFormSchema = z.object({
  siteKey: z.string().min(1).max(128),
  formSlug: z.string().min(1).max(128),
  formName: z.string().max(200).optional(),
  data: z.record(z.unknown()).default({}),
  visitorId: z.string().max(128).optional(),
  sessionId: z.string().max(128).optional(),
  pageUrl: z.string().max(2048).optional(),
  utm: z
    .object({
      source: z.string().max(128).optional(),
      medium: z.string().max(128).optional(),
      campaign: z.string().max(128).optional(),
    })
    .optional(),
});

export type IngestFormPayload = z.infer<typeof IngestFormSchema>;

/**
 * Filtres pour `listSubmissions()`.
 */
export const ListSubmissionsFiltersSchema = z.object({
  formSlug: z.string().max(128).optional(),
  // ISO date string (inclusive)
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});

export type ListSubmissionsFilters = z.infer<typeof ListSubmissionsFiltersSchema>;

/**
 * Champs renvoyés par `listSubmissions()` — projection ciblée.
 */
export interface SubmissionListItem {
  id: string;
  formSlug: string;
  createdAt: Date;
  pageUrl: string | null;
  leadId: string | null;
  // On exclut le `data` complet du listing (peut être très large) — détail
  // accessible via /api/admin/lead/:id si besoin.
  leadEmail: string | null;
}

export interface ListSubmissionsResult {
  items: SubmissionListItem[];
  nextCursor: string | null;
}

export interface LeadDetails {
  lead: {
    id: string;
    siteId: string;
    email: string | null;
    phone: string | null;
    name: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    submissionsCount: number;
    metadata: unknown;
  };
  submissions: Array<{
    id: string;
    formSlug: string;
    data: unknown;
    pageUrl: string | null;
    createdAt: Date;
  }>;
  sessions: Array<{
    id: string;
    visitorId: string | null;
    sessionId: string | null;
    source: string | null;
    medium: string | null;
    campaign: string | null;
    startedAt: Date;
    endedAt: Date | null;
    pageviewCount: number;
  }>;
}
