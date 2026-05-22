/**
 * Credentials self-service (U8) — barrel export.
 */

export {
  encryptJson,
  decryptJson,
  readEncryptionKeyFromEnv,
  CredentialCryptoError,
  type EncryptedBlob,
} from "./crypto.js";

export {
  CREDENTIAL_KINDS,
  isCredentialKind,
  maskSecret,
  getProvider,
  PROVIDERS,
  OvhCredsSchema,
  TelnyxCredsSchema,
  type CredentialKind,
  type OvhCreds,
  type TelnyxCreds,
  type ClearCreds,
  type MaskedCredential,
  type ProviderDef,
  type ConnectionTestResult,
} from "./providers.js";

export {
  saveCredential,
  listCredentials,
  testCredential,
  deleteCredential,
  CredentialError,
  type CredentialView,
} from "./store.js";
