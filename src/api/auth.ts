// POST /auth/login   email + password -> access + refresh tokens
// POST /auth/refresh refresh token    -> a fresh access + refresh pair
//
// No registration, no password reset, no OAuth — those are out of scope. Users
// come from the seed and (later) an admin path.

import { Router } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { prismaBase } from '../infra/prismaBase.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  TokenError,
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
} from '../auth/tokens.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

type TenantBinding = { tenantId: string | null; crossTenant: boolean };

// A DISPATCHER acts across all tenants and is bound to none. Everyone else acts
// for exactly one tenant — their first membership. (Multi-membership users are
// a later concern; the seed gives each user one.)
function resolveTenantBinding(
  role: Role,
  memberships: { tenantId: string }[],
): TenantBinding {
  if (role === 'DISPATCHER') {
    return { tenantId: null, crossTenant: true };
  }
  return { tenantId: memberships[0]?.tenantId ?? null, crossTenant: false };
}

// The domain-actor id the row-ownership rule filters jobs by. A DRIVER's jobs
// are matched on Job.driverId (= Driver.id), a TECHNICIAN's on
// Job.assignedTechnicianId (= Technician.id) — neither is the user id, so it is
// resolved here and carried in the token like tenantId. Undefined for roles
// that have tenant-wide read (DISPATCHER, FLEET_MANAGER).
function resolveActorId(user: {
  role: Role;
  driver: { id: string } | null;
  technician: { id: string } | null;
}): string | undefined {
  if (user.role === 'DRIVER') return user.driver?.id;
  if (user.role === 'TECHNICIAN') return user.technician?.id;
  return undefined;
}

async function loadActiveUser(where: { id: string } | { email: string }) {
  const user = await prismaBase.user.findUnique({
    where,
    include: {
      memberships: { select: { tenantId: true } },
      driver: { select: { id: true } },
      technician: { select: { id: true } },
    },
  });
  if (!user || !user.active) return null;
  return user;
}

authRouter.post('/auth/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await loadActiveUser({ email });
  // Same response whether the email is unknown or the password is wrong —
  // never reveal which.
  const passwordOk = user ? await verifyPassword(user.passwordHash, password) : false;
  if (!user || !passwordOk) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  const binding = resolveTenantBinding(user.role, user.memberships);
  const actorId = resolveActorId(user);
  res.json({
    accessToken: issueAccessToken({
      sub: user.id,
      role: user.role,
      tenantId: binding.tenantId,
      crossTenant: binding.crossTenant,
      actorId,
    }),
    refreshToken: issueRefreshToken({ sub: user.id }),
    user: { id: user.id, email: user.email, role: user.role, tenantId: binding.tenantId },
  });
});

authRouter.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);

  let subject: string;
  try {
    subject = verifyRefreshToken(refreshToken).sub;
  } catch (error) {
    if (error instanceof TokenError) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    throw error;
  }

  const user = await loadActiveUser({ id: subject });
  if (!user) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  // Re-derive the binding so a membership change since the last login takes
  // effect on refresh rather than only on a fresh login.
  const binding = resolveTenantBinding(user.role, user.memberships);
  const actorId = resolveActorId(user);
  res.json({
    accessToken: issueAccessToken({
      sub: user.id,
      role: user.role,
      tenantId: binding.tenantId,
      crossTenant: binding.crossTenant,
      actorId,
    }),
    refreshToken: issueRefreshToken({ sub: user.id }),
  });
});
