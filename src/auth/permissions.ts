// The permission table. Role -> resource -> the actions that role may take on
// it. One data structure, queried through one function `can()`. RBAC checks
// must never be scattered if-statements across route handlers — when someone
// asks "what can a technician do?" the answer has to be readable in one place.
//
// This governs the ACTION (may this role read a job at all?). It says nothing
// about WHICH rows — that is tenant scoping, enforced separately in
// src/infra/tenantScopeExtension.ts. A FLEET_MANAGER may `read` `job`, but the
// scope layer still limits them to their own tenant's jobs.

import type { Role } from '@prisma/client';

export type Action = 'read' | 'create' | 'update' | 'delete';
export type Resource = 'job' | 'unit' | 'technician' | 'driver' | 'user' | 'auditLog';

type PermissionTable = Record<Role, Partial<Record<Resource, Action[]>>>;

const PERMISSIONS: PermissionTable = {
  DRIVER: {
    job: ['read', 'create'],
    driver: ['read'],
  },
  TECHNICIAN: {
    job: ['read', 'update'],
    unit: ['read'],
    technician: ['read'],
  },
  DISPATCHER: {
    job: ['read', 'create', 'update', 'delete'],
    unit: ['read', 'update'],
    technician: ['read'],
    driver: ['read'],
    user: ['read'],
    auditLog: ['read'],
  },
  FLEET_MANAGER: {
    job: ['read'],
    driver: ['read'],
    unit: ['read'],
    technician: ['read'],
  },
};

export function can(user: { role: Role }, action: Action, resource: Resource): boolean {
  const allowed = PERMISSIONS[user.role][resource];
  if (!allowed) return false;
  return allowed.includes(action);
}
