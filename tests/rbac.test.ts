// Pure unit tests — no database. The permission table, the tenant-scope
// decision function, token round-tripping and password verification.

import { describe, expect, it } from 'vitest';
import { NO_OWNER, can, jobReadOwnershipFilter } from '../src/auth/permissions.js';
import type { AuthContext } from '../src/auth/context.js';
import {
  NO_TENANT,
  isTenantScopedModel,
  operationTakesWhereFilter,
  tenantFilterValue,
} from '../src/auth/tenantScope.js';
import { TokenError, issueAccessToken, verifyAccessToken } from '../src/auth/tokens.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

describe('can() — the permission table', () => {
  it('lets a DRIVER create and read jobs but not delete them', () => {
    expect(can({ role: 'DRIVER' }, 'create', 'job')).toBe(true);
    expect(can({ role: 'DRIVER' }, 'read', 'job')).toBe(true);
    expect(can({ role: 'DRIVER' }, 'delete', 'job')).toBe(false);
    expect(can({ role: 'DRIVER' }, 'update', 'job')).toBe(false);
  });

  it('lets a TECHNICIAN read and update a job but not create or delete one', () => {
    expect(can({ role: 'TECHNICIAN' }, 'update', 'job')).toBe(true);
    expect(can({ role: 'TECHNICIAN' }, 'create', 'job')).toBe(false);
    expect(can({ role: 'TECHNICIAN' }, 'delete', 'job')).toBe(false);
  });

  it('gives a FLEET_MANAGER read-only access and nothing more', () => {
    expect(can({ role: 'FLEET_MANAGER' }, 'read', 'job')).toBe(true);
    expect(can({ role: 'FLEET_MANAGER' }, 'update', 'job')).toBe(false);
    expect(can({ role: 'FLEET_MANAGER' }, 'create', 'job')).toBe(false);
    expect(can({ role: 'FLEET_MANAGER' }, 'read', 'auditLog')).toBe(false);
  });

  it('lets a DISPATCHER do everything to a job and read the audit log', () => {
    expect(can({ role: 'DISPATCHER' }, 'delete', 'job')).toBe(true);
    expect(can({ role: 'DISPATCHER' }, 'read', 'auditLog')).toBe(true);
  });

  it('denies an action on a resource the role has no entry for', () => {
    expect(can({ role: 'TECHNICIAN' }, 'read', 'auditLog')).toBe(false);
    expect(can({ role: 'DRIVER' }, 'read', 'unit')).toBe(false);
  });
});

describe('jobReadOwnershipFilter() — the row-ownership decision', () => {
  const base = { userId: 'u1', tenantId: 'tenant-a', crossTenant: false };

  it('narrows a DRIVER to jobs they raised', () => {
    const ctx: AuthContext = { ...base, role: 'DRIVER', actorId: 'driver-7' };
    expect(jobReadOwnershipFilter(ctx)).toEqual({ driverId: 'driver-7' });
  });

  it('narrows a TECHNICIAN to jobs assigned to them', () => {
    const ctx: AuthContext = { ...base, role: 'TECHNICIAN', actorId: 'tech-3' };
    expect(jobReadOwnershipFilter(ctx)).toEqual({ assignedTechnicianId: 'tech-3' });
  });

  it('does not narrow a FLEET_MANAGER or a DISPATCHER', () => {
    expect(jobReadOwnershipFilter({ ...base, role: 'FLEET_MANAGER' })).toEqual({});
    expect(
      jobReadOwnershipFilter({ userId: 'd1', role: 'DISPATCHER', tenantId: null, crossTenant: true }),
    ).toEqual({});
  });

  it('fails closed: a DRIVER/TECHNICIAN token with no actorId filters by an impossible id', () => {
    expect(jobReadOwnershipFilter({ ...base, role: 'DRIVER' })).toEqual({ driverId: NO_OWNER });
    expect(jobReadOwnershipFilter({ ...base, role: 'TECHNICIAN' })).toEqual({
      assignedTechnicianId: NO_OWNER,
    });
  });

  it('does not narrow when there is no auth context (tenant scoping still returns nothing)', () => {
    expect(jobReadOwnershipFilter(undefined)).toEqual({});
  });
});

describe('tenantFilterValue() — the scope decision', () => {
  const base = { userId: 'u1', role: 'FLEET_MANAGER' as const };

  it('returns the caller tenant id when they are scoped to one', () => {
    expect(tenantFilterValue({ ...base, tenantId: 'tenant-a', crossTenant: false })).toBe('tenant-a');
  });

  it('returns null (no filter) for a cross-tenant caller', () => {
    expect(
      tenantFilterValue({ userId: 'd1', role: 'DISPATCHER', tenantId: null, crossTenant: true }),
    ).toBeNull();
  });

  it('returns an impossible id when there is no context at all', () => {
    expect(tenantFilterValue(undefined)).toBe(NO_TENANT);
  });

  it('returns an impossible id for a scoped caller with no tenant', () => {
    expect(tenantFilterValue({ ...base, tenantId: null, crossTenant: false })).toBe(NO_TENANT);
  });
});

describe('tenant-scope model and operation classification', () => {
  it('knows Job is tenant-scoped and Unit is not', () => {
    expect(isTenantScopedModel('Job')).toBe(true);
    expect(isTenantScopedModel('Unit')).toBe(false);
    expect(isTenantScopedModel(undefined)).toBe(false);
  });

  it('will inject a where filter for findMany but not for findUnique', () => {
    expect(operationTakesWhereFilter('findMany')).toBe(true);
    expect(operationTakesWhereFilter('updateMany')).toBe(true);
    expect(operationTakesWhereFilter('findUnique')).toBe(false);
    expect(operationTakesWhereFilter('create')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips the claims', () => {
    const token = issueAccessToken({
      sub: 'user-1',
      role: 'FLEET_MANAGER',
      tenantId: 'tenant-a',
      crossTenant: false,
    });
    const claims = verifyAccessToken(token);
    expect(claims).toMatchObject({
      sub: 'user-1',
      role: 'FLEET_MANAGER',
      tenantId: 'tenant-a',
      crossTenant: false,
    });
  });

  it('round-trips the actorId claim for a DRIVER and omits it for other roles', () => {
    const driverClaims = verifyAccessToken(
      issueAccessToken({
        sub: 'user-1',
        role: 'DRIVER',
        tenantId: 'tenant-a',
        crossTenant: false,
        actorId: 'driver-7',
      }),
    );
    expect(driverClaims.actorId).toBe('driver-7');

    const fmClaims = verifyAccessToken(
      issueAccessToken({
        sub: 'user-2',
        role: 'FLEET_MANAGER',
        tenantId: 'tenant-a',
        crossTenant: false,
      }),
    );
    expect(fmClaims.actorId).toBeUndefined();
  });

  it('rejects a tampered token with a TokenError', () => {
    const token = issueAccessToken({
      sub: 'user-1',
      role: 'DRIVER',
      tenantId: null,
      crossTenant: false,
    });
    expect(() => verifyAccessToken(token + 'x')).toThrow(TokenError);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-real-hash', 'whatever')).toBe(false);
  });
});
