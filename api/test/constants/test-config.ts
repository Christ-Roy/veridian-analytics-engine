/**
 * Shared test configuration constants
 *
 * This file centralizes all test environment configuration to eliminate
 * duplication across test files. Import and call setupTestEnv() at the
 * top of each test file BEFORE any other imports.
 */

// Database constants
export const TEST_SYSTEM_DATABASE = 'staminads_test_system';
export const TEST_WORKSPACE_DATABASE = 'staminads_test_ws';

// ClickHouse connection
export const CLICKHOUSE_HOST = 'http://localhost:8123';
export const CLICKHOUSE_USER = 'default';
export const CLICKHOUSE_PASSWORD = '';

// Auth constants
export const ADMIN_EMAIL = 'super-admin@test.com';
export const ADMIN_PASSWORD = 'testpass';
export const ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!';

// App constants
export const APP_URL = 'http://localhost:5173';

// Platform admin M2M shared secret (used by /api/admin/platform/* guard).
// Set globally so the value is present BEFORE the first AppModule is
// compiled — ConfigModule snapshots process.env at compile time, and
// once a previous test file has booted AppModule, late writes to
// process.env in another spec file are ignored. Hardcoding here keeps
// the admin-platform e2e suite hermetic regardless of file load order.
export const PLATFORM_ADMIN_API_KEY = 'test-platform-admin-key-do-not-use';

// Pre-hashed password for 'testpass123' - avoids async hashing in tests
export const TEST_PASSWORD = 'testpass123';
export const TEST_PASSWORD_HASH =
  '$2b$10$.192dSMq29IhccQVJ4CyYu55LTiohEQmrOS6SMtxvSWMiX9H2c.ua';

/**
 * Setup test environment variables.
 * MUST be called at the top of each test file BEFORE any imports.
 *
 * @example
 * // At the very top of your test file:
 * import { setupTestEnv } from './constants/test-config';
 * setupTestEnv();
 *
 * // Then other imports...
 * import { INestApplication } from '@nestjs/common';
 */
export function setupTestEnv(options: { corsOrigins?: string[] } = {}): void {
  process.env.NODE_ENV = 'test';
  process.env.CLICKHOUSE_SYSTEM_DATABASE = TEST_SYSTEM_DATABASE;
  process.env.CLICKHOUSE_HOST = CLICKHOUSE_HOST;
  process.env.CLICKHOUSE_USER = CLICKHOUSE_USER;
  process.env.CLICKHOUSE_PASSWORD = CLICKHOUSE_PASSWORD;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.APP_URL = APP_URL;
  process.env.SMTP_HOST = '';
  process.env.PLATFORM_ADMIN_API_KEY = PLATFORM_ADMIN_API_KEY;

  if (options.corsOrigins) {
    process.env.CORS_ALLOWED_ORIGINS = options.corsOrigins.join(',');
  }
}

/**
 * Get ClickHouse client configuration for system database
 */
export function getSystemClientConfig() {
  return {
    url: process.env.CLICKHOUSE_HOST || CLICKHOUSE_HOST,
    database: TEST_SYSTEM_DATABASE,
  };
}

/**
 * Get ClickHouse client configuration for a workspace database
 */
export function getWorkspaceClientConfig(workspaceId?: string) {
  const database = workspaceId
    ? `staminads_ws_${workspaceId}`
    : TEST_WORKSPACE_DATABASE;
  return {
    url: process.env.CLICKHOUSE_HOST || CLICKHOUSE_HOST,
    database,
  };
}
