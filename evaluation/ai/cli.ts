// npm run eval:ai — the AI intake evaluation.
//
//   npm run eval:ai                       the keyword control, plus the model
//                                         when LLM_API_KEY is set
//   npm run eval:ai -- --extractor llm    the model only
//   npm run eval:ai -- --limit 12         a cheap smoke run over 12 cases
//
// WITH NO KEY THIS STILL PRINTS A TABLE, and that is deliberate: a report that
// can only be produced by spending money is a report nobody runs, and the
// control's numbers are the ones the model has to beat. When the model is
// skipped the output says so in a line, rather than quietly reporting one row.

import { writeFileSync } from 'node:fs';
import { CASES } from './cases.js';
import { computeAiMetrics } from './metrics.js';
import { keywordBaselineExtractor, llmExtractor, runCases } from './runner.js';
import type { Extractor } from './runner.js';
import { buildReport, metricsTable } from './report.js';
import type { AiRow } from './report.js';
import { isLlmConfigured } from '../../src/ai/client.js';

const OUT_FILE = 'EVALUATION_AI.md';

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const requested = flagValue(argv, 'extractor');
  const limitArg = flagValue(argv, 'limit');
  const limit = limitArg ? Number(limitArg) : CASES.length;
  const cases = CASES.slice(0, limit);

  const extractors: Extractor[] = [];
  if (requested === null || requested === 'keyword-baseline') extractors.push(keywordBaselineExtractor);
  if (requested === 'llm' || (requested === null && isLlmConfigured())) extractors.push(llmExtractor);

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
