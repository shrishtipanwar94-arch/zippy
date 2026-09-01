// npm run eval:ai — the AI intake evaluation.
//
//   npm run eval:ai                       the keyword control, plus the model
//                                         when LLM_API_KEY is set
//   npm run eval:ai -- --extractor llm    the model only
//   npm run eval:ai -- --limit 12         a cheap smoke run over 12 cases
//   npm run eval:ai -- --pacing 2000      shorter waits between model calls
//
// PACING. The free tier this was measured on allows 8,000 tokens per minute,
// which is about four extractions. The default wait keeps the run under that;
// an account with a real quota should drop it. See runner.ts for why the
// harness waits at all when the product deliberately does not.
//
// WITH NO KEY THIS STILL PRINTS A TABLE, and that is deliberate: a report that
// can only be produced by spending money is a report nobody runs, and the
// control's numbers are the ones the model has to beat. When the model is
// skipped the output says so in a line, rather than quietly reporting one row.

import { writeFileSync } from 'node:fs';
import { CASES } from './cases.js';
import { computeAiMetrics } from './metrics.js';
import { createLlmExtractor, keywordBaselineExtractor, runCases } from './runner.js';
import type { Extractor, PacedExtractor } from './runner.js';
import { buildReport, metricsTable } from './report.js';
import type { AiRow } from './report.js';
import { isLlmConfigured } from '../../src/ai/client.js';

const OUT_FILE = 'EVALUATION_AI.md';

// Thirteen seconds between calls. The prompt is about 1,500 tokens, so at the
// free tier's 8,000 tokens per minute this is roughly the fastest a run can go
// without being throttled into meaninglessness.
const DEFAULT_PACING_MS = 13_000;

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const requested = flagValue(argv, 'extractor');
  const limitArg = flagValue(argv, 'limit');
  const pacingArg = flagValue(argv, 'pacing');
  const pacingMs = pacingArg ? Number(pacingArg) : DEFAULT_PACING_MS;
  const limit = limitArg ? Number(limitArg) : CASES.length;
  const cases = CASES.slice(0, limit);

  const extractors: Extractor[] = [];
  if (requested === null || requested === 'keyword-baseline') extractors.push(keywordBaselineExtractor);

  let paced: PacedExtractor | null = null;
  if (requested === 'llm' || (requested === null && isLlmConfigured())) {
    paced = createLlmExtractor(pacingMs);
    extractors.push(paced);
  }

  if (requested === null && !isLlmConfigured()) {
    console.error('LLM_API_KEY is not set — running the keyword control only.');
  }

  const rows: AiRow[] = [];
  for (const extractor of extractors) {
    const startedAt = Date.now();
    const outcomes = await runCases(extractor, cases);
    // Wall clock to stderr, never into the table: it is the one number two
    // runs cannot reproduce, and the dispatch harness draws the same line.
    console.error(`${extractor.name}: ${cases.length} cases in ${Date.now() - startedAt}ms`);
    if (paced && extractor === paced) {
      console.error(
        `${extractor.name}: ${paced.rateLimitWaits()} rate-limit waits, ` +
          `${paced.rateLimitFailures()} cases abandoned to rate limiting`,
      );
    }
    rows.push({ extractor: extractor.name, metrics: computeAiMetrics(outcomes), outcomes });
  }

  console.log(metricsTable(rows));
  writeFileSync(OUT_FILE, buildReport(rows), 'utf8');
  console.error(`\nwrote ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
