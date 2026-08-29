// Two middlewares that guard every non-public route.
//
// `authenticate` verifies the bearer access token, hangs the caller's identity
// on `req.auth`, and runs the rest of the request inside the AsyncLocalStorage
// auth context so the Prisma tenant-scope extension can see it.
//
// `requirePermission(action, resource)` is the RBAC gate — it consults the
// permission table and returns 403 if the role is not allowed the action.
// It answers "may this ROLE do this?", never "may they touch THIS ROW?" —
// row-level tenant scoping is the extension's job.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { runWithAuthContext } from '../../auth/context.js';
import type { AuthContext } from '../../auth/context.js';
import { can } from '../../auth/permissions.js';
import type { Action, Resource } from '../../auth/permissions.js';
import { TokenError, verifyAccessToken } from '../../auth/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value;
}

export const authenticate: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'missing_bearer_token' });
    return;
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof TokenError) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    throw error;
  }

  const context: AuthContext = {
    userId: claims.sub,
    role: claims.role,
    tenantId: claims.tenantId,
    crossTenant: claims.crossTenant,
    actorId: claims.actorId,
  };
  req.auth = context;

  // Everything downstream — route handlers and the Prisma queries they make —
  // runs inside this context.
  runWithAuthContext(context, () => next());
};

export function requirePermission(action: Action, resource: Resource): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (!can({ role: req.auth.role }, action, resource)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
