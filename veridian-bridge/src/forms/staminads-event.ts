/**
 * Push d'un event `form_submission` vers staminads.
 *
 * Cf endpoint `/api/track` (déjà utilisé par `app.ts → /api/admin/track-test`).
 * Format payload aligné sur staminads :
 *   {
 *     workspace_id, session_id, created_at, updated_at,
 *     sdk_version, actions: [{ type: "goal", name: "form_submission", ... }],
 *     attributes: { lead_id, form_slug, ... }
 *   }
 *
 * Failure tolerant : si staminads est down, on ne casse pas l'ingest
 * Postgres (les données business sont safe en DB ; l'event analytics est
 * "nice to have"). On loggue en warning et on retourne le code HTTP.
 */

export interface PushFormEventArgs {
  staminadsUrl: string;
  workspaceId: string;
  sessionId: string;
  formSlug: string;
  leadId: string | null;
  submissionId: string;
  pageUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export interface PushFormEventResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function pushFormSubmissionEvent(
  args: PushFormEventArgs,
): Promise<PushFormEventResult> {
  const f = args.fetchImpl ?? fetch;
  const now = Date.now();
  const payload = {
    workspace_id: args.workspaceId,
    session_id: args.sessionId,
    created_at: now,
    updated_at: now,
    sdk_version: "veridian-bridge-forms-0.1",
    actions: [
      {
        type: "goal",
        name: "form_submission",
        path: args.pageUrl ?? "/",
        page_number: 1,
        timestamp: now,
      },
    ],
    attributes: {
      // Custom dim — staminads les indexe en col `properties` côté events.
      lead_id: args.leadId ?? "",
      form_slug: args.formSlug,
      submission_id: args.submissionId,
    },
  };

  try {
    const res = await f(`${args.staminadsUrl}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `staminads_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err as Error).message,
    };
  }
}
