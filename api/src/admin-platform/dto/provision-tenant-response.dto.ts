export interface PhoneNumberProvisionStatus {
  e164: string;
  source: string;
  status: 'attached' | 'skipped_no_bridge' | 'failed';
  error?: string;
}

export class ProvisionTenantResponseDto {
  /**
   * Slugified workspace id (e.g. "boulangerie-dupont"). This is the canonical
   * tenant identifier used everywhere downstream (bridge, dashboard URL,
   * tracker `data-workspace-id`).
   */
  workspace_id: string;

  /**
   * UUID of the newly created owner user.
   */
  owner_user_id: string;

  /**
   * Raw API key — `stam_live_*` format. **ONLY returned in this response,
   * never queryable again.** The caller must persist it (typically inside
   * Hub's encrypted tenant record).
   */
  api_key: string;

  /**
   * Ready-to-paste tracker snippet for the customer website.
   */
  snippet_html: string;

  /**
   * Direct URL to the workspace dashboard. The owner is invited to set
   * their password before they can log in.
   */
  dashboard_url: string;

  /**
   * Password reset URL — also sent by email, but exposed here so the
   * Hub can show "magic link sent to {email}" in its UI.
   */
  password_reset_url: string;

  /**
   * Phone number provisioning status — one entry per requested phone.
   * Empty array if no phoneNumbers were provided.
   */
  phone_numbers: PhoneNumberProvisionStatus[];

  /**
   * Whether a fresh user was created vs reused (always `true` in V1 —
   * the service returns 409 on duplicate email — but exposed for
   * forward-compat when the "reuse existing user" path lands).
   */
  user_created: boolean;
}
