// `npm run sim -- --rate 40 --duration 60`
//
// Two modes, one code path:
//   one-shot (default) — generate the whole run as fast as the database allows,
//     print a deterministic report, exit. This is what the evaluation harness
//     and the reproducibility check use.
//   --live             — the same run, paced in real time, looping forever so a
//     deployed dispatch board is never empty. Stops on SIGINT/SIGTERM or when
//     the kill switch key is set in Redis.
//
// Output goes to console.log, not the pino logger, on purpose: this report is
// meant to be diffed between two runs, and structured log lines carry
// timestamps and a pid that would differ every time.

import { prismaBase } from '../infra/prismaBase.js';
import { DEFAULT_CONFIG, parseFaultMix, parseSituationMix } from './config.js';
import type { SimulatorConfig } from './config.js';
import { runSimulation } from './runner.js';
import { diagnosisWasCorrect, summarise } from './outcomes.js';
import type { SimulatedJob } from './outcomes.js';

// Set this key in Redis to stop a live simulator without killing the process:
//   docker compose exec redis redis-cli SET zippy:sim:stop 1
const KILL_SWITCH_KEY = 'zippy:sim:stop';
const LIVE_SECONDS_PER_SIMULATED_MINUTE = 1;

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;

    const name = token.slice(2);
    const nextToken = argv[index + 1];
    if (nextToken === undefined || nextToken.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = nextToken;
    index += 1;
  }
  return flags;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = flags[name];
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function configFromFlags(flags: Flags): SimulatorConfig {
  const live = flags.live === true;
  const faultMix = typeof flags['fault-mix'] === 'string' ? parseFaultMix(flags['fault-mix']) : DEFAULT_CONFIG.faultMix;
  const situationMix =
    typeof flags['situation-mix'] === 'string'
      ? parseSituationMix(flags['situation-mix'])
      : DEFAULT_CONFIG.situationMix;

  return {
    seed: numberFlag(flags, 'seed', DEFAULT_CONFIG.seed),
    arrivalsPerHour: numberFlag(flags, 'rate', DEFAULT_CONFIG.arrivalsPerHour),
    durationMinutes: numberFlag(flags, 'duration', DEFAULT_CONFIG.durationMinutes),
    faultMix,
    situationMix,
    maxJobs: typeof flags['max-jobs'] === 'string' ? numberFlag(flags, 'max-jobs', 0) : null,
    realSecondsPerSimulatedMinute: live
      ? numberFlag(flags, 'pace', LIVE_SECONDS_PER_SIMULATED_MINUTE)
      : 0,
    // A live board must look current, so it runs on the wall clock and is
    // therefore NOT reproducible. Every other mode is.
    startAtIso: live ? null : (typeof flags.start === 'string' ? flags.start : DEFAULT_CONFIG.startAtIso),
  };
}

function formatOffset(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = String(Math.floor(whole / 60)).padStart(3, '0');
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

function printJob(job: SimulatedJob): void {
  console.log(
    [
      `#${String(job.index).padStart(3, '0')}`,
      `t+${formatOffset(job.arrivalOffsetSeconds)}`,
      `true=${job.trueFault}`,
      `said=${job.primaryComplaint}`,
      `${job.situation}/${job.safetyLevel}`,
      `q=${job.questionsAsked}`,
      `H ${job.entropyStartBits.toFixed(3)}->${job.entropyEndBits.toFixed(3)}`,
      `stop=${job.stopReason}`,
      `top=${job.topFault}${diagnosisWasCorrect(job) ? '' : '(wrong)'}`,
      `caps=${job.requiredCapabilityCodes.join('+')}`,
    ].join(' '),
  );
}

function printSummary(jobs: SimulatedJob[], config: SimulatorConfig): void {
  const summary = summarise(jobs);
  const counts = Object.keys(summary.questionCounts)
    .map(Number)
    .sort((a, b) => a - b)
    .map((count) => `${count}q:${summary.questionCounts[count]}`)
    .join(' ');

  console.log('---');
  console.log(`seed=${config.seed} rate=${config.arrivalsPerHour}/h duration=${config.durationMinutes}min jobs=${summary.jobs}`);
  console.log(`questions ${counts}  mean=${summary.meanQuestions.toFixed(2)}`);
  console.log(`stop reasons ${JSON.stringify(summary.stopReasons)}`);
  console.log(`safety ${JSON.stringify(summary.safetyLevels)}`);
  console.log(`entropy mean ${summary.meanEntropyStartBits.toFixed(3)} -> ${summary.meanEntropyEndBits.toFixed(3)} bits`);
  console.log(`top-fault accuracy ${(summary.topFaultAccuracy * 100).toFixed(1)}%`);
  console.log(`jobs that ended less certain than they started: ${summary.jobsThatEndedLessCertain}`);
}

async function killSwitchIsSet(): Promise<boolean> {
  // Imported lazily so a one-shot run never opens a Redis connection.
  const { redis } = await import('../infra/redis.js');
  const value = await redis.get(KILL_SWITCH_KEY).catch(() => null);
  return value !== null;
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = configFromFlags(flags);
  const live = flags.live === true;

  let stopped = false;
  const stop = (signal: string) => {
    console.log(`--- ${signal} received, finishing the current job and stopping`);
    stopped = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  if (!live) {
    const jobs = await runSimulation(prismaBase, config, {
      onJob: printJob,
      shouldStop: () => stopped,
    });
    printSummary(jobs, config);
    await prismaBase.$disconnect();
    return;
  }

  // The long-lived worker: the same run, over and over, on the wall clock. The
  // seed advances each pass so a board left running for a day does not replay
  // the same forty breakdowns.
  let pass = 0;
  while (!stopped) {
    const passConfig = { ...config, seed: config.seed + pass };
    console.log(`--- live pass ${pass + 1} (seed ${passConfig.seed})`);
    await runSimulation(prismaBase, passConfig, {
      onJob: printJob,
      shouldStop: async () => stopped || (await killSwitchIsSet()),
      waitMs: sleep,
    });
    pass += 1;
  }

  await prismaBase.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await prismaBase.$disconnect().catch(() => undefined);
  process.exit(1);
});
