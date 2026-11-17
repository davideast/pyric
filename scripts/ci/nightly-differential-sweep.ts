#!/usr/bin/env bun
/**
 * Scheduled nightly differential sweep launcher for `.github/workflows/build.yml`.
 *
 * Derives a deterministic disjoint 2,000-seed window from the UTC calendar date
 * (`1000 + dayOffset * 2000`, anchored at `2026-01-01T00:00:00Z`) so every
 * nightly run exercises fresh multi-step RTDB and Firestore operation sequences
 * instead of re-testing the fixed `--start=1000` range, while keeping any
 * failure 100% reproducible via the printed `--start=<seed>` command or
 * `NIGHTLY_SWEEP_DATE=YYYY-MM-DD`.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const EPOCH_UTC_MS = Date.UTC(2026, 0, 1);
const MS_PER_UTC_DAY = 86_400_000;
const BASE_START_SEED = 1000;
const NIGHTLY_COUNT = 2000;
const NIGHTLY_STEPS = 40;
const NIGHTLY_CHUNKS = 2;

export interface NightlySweepWindow {
  utcDate: string;
  dayOffset: number;
  start: number;
  count: number;
  steps: number;
  chunks: number;
}

export interface NightlySweepInvocation {
  target: 'rtdb' | 'firestore';
  script: string;
  args: string[];
  replayCommand: string;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseOverrideDate(raw: string): Date {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || formatUtcDate(parsed) !== trimmed) {
      throw new Error(
        `Invalid NIGHTLY_SWEEP_DATE '${raw}': expected YYYY-MM-DD or ISO-8601 timestamp`,
      );
    }
    return parsed;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid NIGHTLY_SWEEP_DATE '${raw}': expected YYYY-MM-DD or ISO-8601 timestamp`,
    );
  }
  return parsed;
}

export function computeNightlySweepWindow(
  now: Date = new Date(),
  explicitStart?: number,
): NightlySweepWindow {
  const utcMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rawOffset = Math.floor((utcMidnightMs - EPOCH_UTC_MS) / MS_PER_UTC_DAY);
  const dayOffset = Math.max(0, rawOffset);
  let start = BASE_START_SEED + dayOffset * NIGHTLY_COUNT;
  if (explicitStart !== undefined) {
    if (!Number.isInteger(explicitStart) || explicitStart < 1) {
      throw new Error(`Invalid NIGHTLY_SWEEP_START '${String(explicitStart)}': expected positive integer`);
    }
    start = explicitStart;
  }
  return {
    utcDate: formatUtcDate(now),
    dayOffset,
    start,
    count: NIGHTLY_COUNT,
    steps: NIGHTLY_STEPS,
    chunks: NIGHTLY_CHUNKS,
  };
}

export function buildNightlySweepInvocation(
  rawTarget: string,
  window: NightlySweepWindow,
): NightlySweepInvocation {
  if (rawTarget !== 'rtdb' && rawTarget !== 'firestore') {
    throw new Error(`Unknown nightly differential target '${rawTarget}': expected 'rtdb' or 'firestore'`);
  }
  const script = `packages/cli/test/serve/${rawTarget}-differential/differential.ts`;
  const args = [
    `--start=${window.start}`,
    `--count=${window.count}`,
    `--steps=${window.steps}`,
    `--chunks=${window.chunks}`,
  ];
  const replayCommand = `bun ${script} ${args.join(' ')}`;
  return {
    target: rawTarget,
    script,
    args,
    replayCommand,
  };
}

export function runNightlySweepCli(options: {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
  log?: (line: string) => void;
  spawnRunner?: (cmd: string, args: string[]) => number;
}): number {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const rawTargetArg = options.argv[0] ?? '';
  const target = rawTargetArg.trim();

  let refDate = options.now ?? new Date();
  const rawDateEnv = env.NIGHTLY_SWEEP_DATE ?? '';
  if (rawDateEnv.trim() !== '') {
    refDate = parseOverrideDate(rawDateEnv);
  }
  let explicitStart: number | undefined;
  const rawStartEnv = env.NIGHTLY_SWEEP_START ?? '';
  if (rawStartEnv.trim() !== '') {
    explicitStart = Number(rawStartEnv.trim());
  }

  const window = computeNightlySweepWindow(refDate, explicitStart);
  const invocation = buildNightlySweepInvocation(target, window);

  log(
    `[nightly-sweep] target=${invocation.target} utcDate=${window.utcDate} start=${window.start} count=${window.count} steps=${window.steps}`,
  );
  log(`[nightly-sweep] replay: ${invocation.replayCommand}`);

  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const md = [
      `### Nightly ${invocation.target} differential sweep (${window.utcDate})`,
      '',
      `- Seed window: \`${window.start}..${window.start + window.count - 1}\` (\`count=${window.count}\`, \`steps=${window.steps}\`)`,
      `- Replay full sweep: \`${invocation.replayCommand}\``,
      '',
    ].join('\n');
    appendFileSync(summaryPath, md);
  }

  if (options.spawnRunner) {
    return options.spawnRunner('bun', [invocation.script, ...invocation.args]);
  }
  const child = spawnSync('bun', [invocation.script, ...invocation.args], {
    stdio: 'inherit',
    env,
  });
  return child.status ?? 1;
}

if (import.meta.main) {
  const exitCode = runNightlySweepCli({ argv: process.argv.slice(2) });
  process.exit(exitCode);
}
