/**
 * The pieces of the long-session soak (long-session-soak/scenario.ts) that
 * hold no browser or process: its settings, a seeded random source, the
 * weighted action picker, the action log a failure prints, and the judge
 * that reads memory samples for steady growth. soak.test.ts covers each.
 *
 * A run is replayable: the same seed draws the same actions, as long as each
 * action's weight depends only on the script's own model, never on a clock.
 */

/** What a soak run does, from SOAK_SEED and SOAK_MINUTES. */
export interface SoakSettings {
  seed: number;
  minutes: number;
  /** How often the state check runs. */
  checkpointMs: number;
  /** How often memory is sampled. */
  sampleMs: number;
}

export const DEFAULT_SEED = 20261104;
export const DEFAULT_MINUTES = 60;
const MAX_CHECKPOINT_MS = 3 * 60_000;
const MIN_CHECKPOINT_MS = 20_000;
const CHECKPOINTS_PER_RUN = 6;
const MAX_SAMPLE_MS = 30_000;
const SAMPLES_PER_CHECKPOINT = 4;

/** A seed from text: a decimal integer as itself, anything else hashed (FNV-1a), so `SOAK_SEED=nightly` works too. */
export function parseSeed(text: string): number {
  const isInteger = /^\d+$/.test(text);
  if (isInteger) return Number(BigInt(text) % 4294967296n);
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The run's settings. Each check runs at least six times a run, and at most three minutes apart. */
export function soakSettings(env: Record<string, string | undefined>): SoakSettings {
  const seedText = env.SOAK_SEED?.trim();
  const seed = seedText ? parseSeed(seedText) : DEFAULT_SEED;
  const minutesText = env.SOAK_MINUTES?.trim();
  const minutes = minutesText ? Number(minutesText) : DEFAULT_MINUTES;
  const isPositive = Number.isFinite(minutes) && minutes > 0;
  if (!isPositive) throw new Error(`SOAK_MINUTES must be a positive number of minutes, not ${JSON.stringify(minutesText)}`);
  const evenSpacing = (minutes * 60_000) / CHECKPOINTS_PER_RUN;
  const checkpointMs = Math.round(Math.min(MAX_CHECKPOINT_MS, Math.max(MIN_CHECKPOINT_MS, evenSpacing)));
  const sampleMs = Math.min(MAX_SAMPLE_MS, Math.round(checkpointMs / SAMPLES_PER_CHECKPOINT));
  return { seed, minutes, checkpointMs, sampleMs };
}

/** A seeded source of random numbers (mulberry32). */
export interface Random {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [min, max]. */
  int(min: number, max: number): number;
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() needs at least one item');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

/** One action the script can take next, and how likely it is. A weight of 0 leaves it out. */
export interface Choice<Name extends string> {
  name: Name;
  weight: number;
}

/** Draws one action by weight. Consumes exactly one draw, so a replay stays in step. */
export function pickAction<Name extends string>(random: Random, choices: readonly Choice<Name>[]): Name {
  const open = choices.filter((choice) => choice.weight > 0);
  const total = open.reduce((sum, choice) => sum + choice.weight, 0);
  if (open.length === 0) throw new Error(`no action has a weight above 0: ${choices.map((choice) => choice.name).join(', ')}`);
  let point = random.next() * total;
  for (const choice of open) {
    point -= choice.weight;
    if (point < 0) return choice.name;
  }
  return open[open.length - 1]!.name;
}

/** One action the script took. */
export interface LoggedAction {
  index: number;
  /** Seconds since the soak started. */
  at: number;
  name: string;
  detail: string;
}

const FAILURE_TAIL = 20;

/** Every action the script took, in order, for the failure report and the saved log. */
export class ActionLog {
  readonly entries: LoggedAction[] = [];
  private readonly started = Date.now();

  /** Records an action and returns its index. */
  add(name: string, detail = ''): number {
    const index = this.entries.length;
    this.entries.push({ index, at: (Date.now() - this.started) / 1000, name, detail });
    return index;
  }

  /** Adds detail to an action after it ran, such as the uid a sign-up returned. */
  note(index: number, detail: string): void {
    const entry = this.entries[index];
    if (entry) entry.detail = entry.detail ? `${entry.detail}; ${detail}` : detail;
  }

  last(count: number): LoggedAction[] {
    return this.entries.slice(-count);
  }

  /** The whole log, one action a line. */
  text(): string {
    return this.entries.map(formatAction).join('\n');
  }

  /** The failure report: how to replay it, then the last 20 actions. */
  describeFailure(seed: number, index: number | undefined, reason: string): string {
    const where = index === undefined ? 'before the first action' : `at action ${index}`;
    return [
      `the soak failed ${where} (SOAK_SEED=${seed}): ${reason}`,
      `replay: SOAK_SEED=${seed} SOAK_MINUTES=<minutes> bun test/apps/run.ts long-session-soak`,
      `the last ${Math.min(FAILURE_TAIL, this.entries.length)} actions:`,
      ...this.last(FAILURE_TAIL).map(formatAction),
    ].join('\n');
  }
}

function formatAction(entry: LoggedAction): string {
  const detail = entry.detail ? ` ${entry.detail}` : '';
  return `#${entry.index} +${entry.at.toFixed(1)}s ${entry.name}${detail}`;
}

/** One memory reading, in bytes. `epoch` counts page loads for a page, restarts for a process: a new epoch starts from scratch. */
export interface MemorySample {
  at: number;
  epoch: number;
  bytes: number;
}

/** How much growth counts. Both bounds must be passed, so small heaps and noisy ones both get room. */
export interface GrowthLimit {
  /** Growth below this many bytes never counts. */
  floorBytes: number;
  /** Growth below this share of the starting level never counts (1 means doubling). */
  ratio: number;
  /** An epoch with fewer samples, after the first, is not judged. */
  minSamples: number;
}

export interface GrowthVerdict {
  growing: boolean;
  /** One line per judged epoch. */
  lines: string[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Whether one epoch's samples grow steadily. The first sample is warm-up and
 * is dropped. The rest split into thirds: the epoch grows when every sample in
 * the last third is above every sample in the first, and the median moved up
 * by more than both bounds of `limit`. A heap that climbs and is collected
 * back down fails the first test; one that settles at a higher level fails
 * the second unless the step is large.
 */
function judgeEpoch(samples: readonly MemorySample[], limit: GrowthLimit): { growing: boolean; line: string } | undefined {
  const judged = samples.slice(1).map((sample) => sample.bytes);
  if (judged.length < limit.minSamples) return undefined;
  const third = Math.max(1, Math.floor(judged.length / 3));
  const first = judged.slice(0, third);
  const last = judged.slice(-third);
  const start = median(first);
  const end = median(last);
  const lastThirdClearsFirst = Math.min(...last) > Math.max(...first);
  const growth = end - start;
  const large = growth > limit.floorBytes && growth > start * limit.ratio;
  const growing = lastThirdClearsFirst && large;
  const line = `epoch ${samples[0]!.epoch}: ${judged.length} samples, ${mb(start)} to ${mb(end)} (${growth >= 0 ? '+' : ''}${mb(growth)})${growing ? ', steady growth' : ''}`;
  return { growing, line };
}

/** Judges each epoch of `samples` on its own, since a reload or restart frees what the last one held. */
export function judgeGrowth(samples: readonly MemorySample[], limit: GrowthLimit): GrowthVerdict {
  const epochs = new Map<number, MemorySample[]>();
  for (const sample of samples) {
    const list = epochs.get(sample.epoch) ?? [];
    list.push(sample);
    epochs.set(sample.epoch, list);
  }
  const verdicts = [...epochs.values()].map((epoch) => judgeEpoch(epoch, limit)).filter((verdict) => verdict !== undefined);
  return { growing: verdicts.some((verdict) => verdict.growing), lines: verdicts.map((verdict) => verdict.line) };
}
