// JWT mint/verify, wrapping `jsonwebtoken` so token shape and secret choice
// live in one place. Two token types, two secrets:
//   access  — short-lived, sent on every request, carries who you are and
//             which tenant you act for
//   refresh — long-lived, only ever sent to POST /auth/refresh, carries just
//             the user id
// A leaked access secret therefore cannot forge a refresh token and vice versa.

import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { config } from '../infra/config.js';

export type AccessTokenClaims = {
  sub: string; // user id
  role: Role;
  tenantId: string | null; // null for a DISPATCHER, who is not bound to a tenant
  crossTenant: boolean; // true only for a DISPATCHER — may read across tenants
  actorId?: string; // Driver.id / Technician.id for those roles; absent otherwise
};

export type RefreshTokenClaims = {
  sub: string;
};

// Thrown for any invalid, expired or malformed token. The route layer maps it
// to 401 without saying which of the three it was.
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

// jsonwebtoken types `expiresIn` as a number of seconds or a template-literal
// string like `15m`. Our config value is a validated non-empty string in that
// vocabulary; this cast narrows `string` to the library's type.
type ExpiresIn = jwt.SignOptions['expiresIn'];

export function issueAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL as ExpiresIn,
  });
}

export function issueRefreshToken(claims: RefreshTokenClaims): string {
  return jwt.sign(claims, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL as ExpiresIn,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = verify(token, config.JWT_ACCESS_SECRET);
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.crossTenant !== 'boolean'
  ) {
    throw new TokenError('access token is missing required claims');
  }
  return {
    sub: payload.sub,
    role: payload.role as Role,
    tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : null,
    crossTenant: payload.crossTenant,
    actorId: typeof payload.actorId === 'string' ? payload.actorId : undefined,
  };
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  const payload = verify(token, config.JWT_REFRESH_SECRET);
  if (typeof payload.sub !== 'string') {
    throw new TokenError('refresh token is missing the subject claim');
  }
  return { sub: payload.sub };
}

// jwt.verify throws its own error types; funnel them all into TokenError so
// callers have one thing to catch.
function verify(token: string, secret: string): jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') {
      throw new TokenError('token payload is a string, expected an object');
    }
    return decoded;
  } catch (error) {
    if (error instanceof TokenError) throw error;
    throw new TokenError(error instanceof Error ? error.message : 'token verification failed');
  }
}
