// One place every unhandled route error passes through, so a client always gets
// clean JSON instead of an HTML stack trace. Express 5 forwards rejected async
// handlers here automatically.

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { TokenError } from '../../auth/tokens.js';

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Express only treats a middleware as an error handler if it declares four
  // parameters, so this stays even though it is unused.
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', details: error.issues });
    return;
  }
  if (error instanceof TokenError) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  req.log?.error({ err: error }, 'unhandled route error');
  res.status(500).json({ error: 'internal_error' });
}
