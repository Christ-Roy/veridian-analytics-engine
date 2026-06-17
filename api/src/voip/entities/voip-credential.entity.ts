import {
  VoipCredentialKind,
  VoipCredentialStatus,
  PhoneSource,
} from '../voip.types';

/**
 * Un credential VoIP tel que stocké en ClickHouse `staminads_system`.
 *
 * `creds_encrypted` est le blob AES-256-GCM clé-par-workspace (cf
 * `VoipCrypto`). Le clear-text n'existe JAMAIS en DB ni dans les réponses API
 * — seul `PublicVoipCredential` (vue masquée) sort du service.
 *
 * Unicité (workspace_id, kind) garantie par le ReplacingMergeTree(updated_at)
 * + le service layer (un upsert remplace le cred existant du même kind).
 */
export interface VoipCredential {
  id: string;
  workspace_id: string;
  kind: VoipCredentialKind;
  creds_encrypted: string;
  status: VoipCredentialStatus;
  last_sync_at: string | null;
  last_tested_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Vue masquée renvoyée par l'API — JAMAIS de clear-text. Reflète le contrat
 * consommé par `voip-panel.tsx` (`CredentialView`).
 */
export interface PublicVoipCredential {
  kind: VoipCredentialKind;
  label: string;
  status: VoipCredentialStatus;
  masked: Record<string, string>;
  lastSyncAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Un numéro tracké (mapping numéro → source) tel que stocké en ClickHouse.
 * Unicité (workspace_id, e164) garantie par le service layer.
 */
export interface PhoneNumberEntity {
  id: string;
  workspace_id: string;
  e164: string;
  source: PhoneSource;
  label: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Vue API d'un numéro tracké (contrat console `TrackedPhoneNumber`). */
export interface PublicPhoneNumber {
  id: string;
  e164: string;
  source: PhoneSource;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}
