import pino from 'pino';
import { config } from './config.js';

/**
 * One structured JSON logger for the whole process. Pino writes newline-
 * delimited JSON to stdout, which is what a deployment platform expects to
 * ingest. Per-request logging (with a request id on every line) is wired up in
 * src/api/app.ts via pino-http, which creates a child logger per request.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  // Emit `level: "info"` rather than `level: 30` so logs are readable without a
  // lookup table.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
