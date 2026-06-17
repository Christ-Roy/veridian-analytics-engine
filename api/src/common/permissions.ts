import { Role } from './entities/membership.entity';

export const PERMISSIONS = {
  // Analytics
  'analytics.view': ['owner', 'admin', 'editor', 'viewer'],
  'analytics.export': ['owner', 'admin', 'editor'],

  // Filters & Annotations
  'filters.manage': ['owner', 'admin', 'editor'],
  'annotations.manage': ['owner', 'admin', 'editor'],

  // Integrations
  'integrations.manage': ['owner', 'admin'],

  // Workspace settings
  'workspace.settings': ['owner', 'admin'],
  'workspace.smtp': ['owner'],
  'workspace.delete': ['owner'],

  // API Keys
  'apiKeys.view': ['owner', 'admin'],
  'apiKeys.manage': ['owner', 'admin'],

  // Webhooks (Phase 1 — cf todo/PATTERNS-WEBHOOKS.md §1)
  'webhook.read': ['owner', 'admin', 'editor', 'viewer'],
  'webhook.write': ['owner', 'admin'],
  'webhook.delete': ['owner', 'admin'],
  'webhook.test': ['owner', 'admin', 'editor'],

  // VoIP (port natif Calls — cf todo/2026-06-16-port-natif-voip.md)
  'voip.read': ['owner', 'admin', 'editor', 'viewer'],
  'voip.write': ['owner', 'admin'],
  'voip.test': ['owner', 'admin', 'editor'],

  // Search Console (port natif GSC — onglet Settings « search-console »)
  // Lecture du dashboard = même niveau qu'analytics.view ; (dé)connexion
  // OAuth / resync = même niveau qu'integrations.manage.
  'gsc.read': ['owner', 'admin', 'editor', 'viewer'],
  'gsc.manage': ['owner', 'admin'],

  // Team management
  'members.invite': ['owner', 'admin'],
  'members.manage': ['owner', 'admin'],
  'members.remove': ['owner', 'admin'],
  'ownership.transfer': ['owner'],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_HIERARCHY: Record<Role, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  viewer: 1,
};

/**
 * Check if a user has a specific permission based on their role
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission];
  return (allowedRoles as readonly string[]).includes(role);
}

/**
 * Check if actor can modify target based on role hierarchy.
 * Returns true if actor's role is strictly higher than target's role.
 */
export function canModifyMember(actorRole: Role, targetRole: Role): boolean {
  return ROLE_HIERARCHY[actorRole] > ROLE_HIERARCHY[targetRole];
}

/**
 * Get all permissions for a given role
 */
export function getPermissionsForRole(role: Role): Permission[] {
  return Object.entries(PERMISSIONS)
    .filter(([, roles]) => (roles as readonly string[]).includes(role))
    .map(([permission]) => permission as Permission);
}

/**
 * Get all roles that have a specific permission
 */
export function getRolesWithPermission(permission: Permission): Role[] {
  return [...PERMISSIONS[permission]] as Role[];
}
