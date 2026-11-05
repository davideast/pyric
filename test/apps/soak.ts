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
  /** How often the dev server's memory is sampled. */
  sampleMs: number;
  /** How often the page's heap is sampled: often enough that a page load of half a minute is judged. */
  pageSampleMs: number;
  /** No dev server restart before this action, so one process lives long enough to show whether its memory levels off. */
  firstRestartAction: number;
}

export const DEFAULT_SEED = 20261104;
export const DEFAULT_MINUTES = 60;
const MAX_CHECKPOINT_MS = 3 * 60_000;
const MIN_CHECKPOINT_MS = 20_000;
const CHECKPOINTS_PER_RUN = 6;
const MAX_SAMPLE_MS = 30_000;
const SAMPLES_PER_CHECKPOINT = 4;
const MAX_PAGE_SAMPLE_MS = 5_000;
/** Actions a minute on a CI runner (6634 in the first full green hour), to turn a share of the run into an action count. */
export const ACTIONS_PER_MINUTE = 110;
/** The share of the run before the first restart. */
const QUIET_SHARE = 0.6;
/** The fewest actions between two restarts. */
export const ACTIONS_BETWEEN_RESTARTS = 600;

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
  const pageSampleMs = Math.min(MAX_PAGE_SAMPLE_MS, sampleMs);
  // An action count, not a time, so the seed replays the same actions.
  const firstRestartAction = Math.max(ACTIONS_BETWEEN_RESTARTS, Math.round(minutes * QUIET_SHARE * ACTIONS_PER_MINUTE));
  return { seed, minutes, checkpointMs, sampleMs, pageSampleMs, firstRestartAction };
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
  /** How long the action took, once it finished. */
  ms?: number;
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

  /** Records how long an action took. */
  finish(index: number): void {
    const entry = this.entries[index];
    if (entry) entry.ms = Date.now() - this.started - entry.at * 1000;
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
  const took = entry.ms === undefined ? '' : ` (${Math.round(entry.ms)} ms)`;
  return `#${entry.index} +${entry.at.toFixed(1)}s ${entry.name}${detail}${took}`;
}

/** Per action name: how many ran, the median and the slowest time, slowest first; then the slowest single actions. */
export function latencyReport(entries: readonly LoggedAction[], slowest: number): string[] {
  const timed = entries.filter((entry) => entry.ms !== undefined);
  const byName = new Map<string, number[]>();
  for (const entry of timed) {
    const list = byName.get(entry.name) ?? [];
    list.push(entry.ms!);
    byName.set(entry.name, list);
  }
  const rows = [...byName]
    .map(([name, times]) => ({ name, count: times.length, median: median(times), max: Math.max(...times) }))
    .sort((a, b) => b.max - a.max)
    .map((row) => `${row.name}: ${row.count} actions, median ${Math.round(row.median)} ms, slowest ${Math.round(row.max)} ms`);
  const slow = [...timed].sort((a, b) => b.ms! - a.ms!).slice(0, slowest).map(formatAction);
  return [...rows, `the ${slow.length} slowest actions:`, ...slow];
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
  /** One line per epoch, judged or not, so a period that was not judged is never silent. */
  lines: string[];
  judged: number;
  epochs: number;
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
function judgeEpoch(samples: readonly MemorySample[], limit: GrowthLimit): { growing: boolean; judged: boolean; line: string } {
  const judged = samples.slice(1).map((sample) => sample.bytes);
  const span = samples[samples.length - 1]!.at - samples[0]!.at;
  if (judged.length < limit.minSamples) {
    const line = `epoch ${samples[0]!.epoch}: not judged, ${samples.length} samples over ${span.toFixed(0)}s (needs ${limit.minSamples + 1})`;
    return { growing: false, judged: false, line };
  }
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
  return { growing, judged: true, line };
}

/** Splits samples by epoch, in order. */
function byEpoch(samples: readonly MemorySample[]): MemorySample[][] {
  const epochs = new Map<number, MemorySample[]>();
  for (const sample of samples) {
    const list = epochs.get(sample.epoch) ?? [];
    list.push(sample);
    epochs.set(sample.epoch, list);
  }
  return [...epochs.values()];
}

/** Judges each epoch of `samples` on its own, since a reload or restart frees what the last one held. */
export function judgeGrowth(samples: readonly MemorySample[], limit: GrowthLimit): GrowthVerdict {
  const verdicts = byEpoch(samples).map((epoch) => judgeEpoch(epoch, limit));
  const judged = verdicts.filter((verdict) => verdict.judged).length;
  const lines = [`${judged} of ${verdicts.length} epochs judged`, ...verdicts.map((verdict) => verdict.line)];
  return { growing: verdicts.some((verdict) => verdict.growing), lines, judged, epochs: verdicts.length };
}

/** How fast memory may still climb once it should have levelled off. */
export interface LevelOffLimit {
  /** An epoch shorter than this is not judged: it may not have reached its caps yet. */
  minMinutes: number;
  /** The second half's Theil-Sen slope above this fails. */
  maxBytesPerMinute: number;
}

/**
 * The Theil-Sen slope of `samples`, in bytes a minute: the median of the
 * slopes between every pair. A single spike moves few of the pairs, so it
 * does not read as a climb, where a least-squares fit follows it.
 */
function slopePerMinute(samples: readonly MemorySample[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const minutes = (samples[j]!.at - samples[i]!.at) / 60;
      if (minutes > 0) slopes.push((samples[j]!.bytes - samples[i]!.bytes) / minutes);
    }
  }
  if (slopes.length === 0) return 0;
  return median(slopes);
}

/**
 * Whether each long epoch levels off. Bounded history (an event cap, a byte
 * cap) climbs until it is full and then holds, so the second half of a long
 * process should be flat; an unbounded one keeps its slope. The second half
 * fails when its Theil-Sen slope is above `maxBytesPerMinute`. Its spread
 * is reported too, as scripts/diagnostics/host-memory-soak.ts reports it.
 */
export function judgeLevelOff(samples: readonly MemorySample[], limit: LevelOffLimit): GrowthVerdict {
  const verdicts = byEpoch(samples).map((epoch) => {
    const start = epoch[0]!.at;
    const minutes = (epoch[epoch.length - 1]!.at - start) / 60;
    const name = `epoch ${epoch[0]!.epoch}`;
    if (minutes < limit.minMinutes) return { growing: false, judged: false, line: `${name}: not judged, ${minutes.toFixed(1)} min (needs ${limit.minMinutes})` };
    const half = epoch.filter((sample) => sample.at - start >= (minutes * 60) / 2);
    const slope = slopePerMinute(half);
    const values = half.map((sample) => sample.bytes);
    const spread = Math.max(...values) - Math.min(...values);
    const growing = slope > limit.maxBytesPerMinute;
    const line = `${name}: ${minutes.toFixed(1)} min, second half ${mb(slope)}/min over ${half.length} samples, spread ${mb(spread)}${growing ? ', still climbing' : ''}`;
    return { growing, judged: true, line };
  });
  const judged = verdicts.filter((verdict) => verdict.judged).length;
  const lines = [`${judged} of ${verdicts.length} epochs judged`, ...verdicts.map((verdict) => verdict.line)];
  return { growing: verdicts.some((verdict) => verdict.growing), lines, judged, epochs: verdicts.length };
}

/** The self size and count of one kind of heap object: an object's constructor, `closure <name>`, or `(<type>)`. */
export interface HeapType {
  name: string;
  count: number;
  bytes: number;
}

interface HeapSnapshotJson {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: [string[], ...unknown[]];
      edge_fields?: string[];
      edge_types?: [string[], ...unknown[]];
    };
  };
  nodes: number[];
  edges?: number[];
  strings: string[];
}

/** What a heap snapshot holds: its kinds of object, and how many references each kind gets from where. */
export interface HeapSummary {
  types: Map<string, HeapType>;
  /** `<kind> <- <holder kind>.<edge>` and how many such references there are. Ids in edge names read as `<id>`. */
  retainers: Map<string, number>;
}

/** A property name with an id or index in it, which would make one path per document, reads as `<id>`. */
function edgeLabel(type: string, name: string): string {
  if (type === 'element' || type === 'hidden') return '[]';
  return name.replace(/\d+|[0-9a-f]{8,}|[A-Za-z0-9_-]{16,}/g, '<id>');
}

/** An object reads as its constructor, a closure as `closure <name>`, anything else as `(<type>)`. */
function nodeKind(type: string, name: string): string {
  if (type === 'object') return name;
  if (type === 'closure') return `closure ${name}`;
  return `(${type})`;
}

/** Sums a V8 heap snapshot's nodes by kind (self sizes, so the sums add up to the heap), and counts their holders. */
export function summarizeHeap(snapshotText: string): HeapSummary {
  const snapshot = JSON.parse(snapshotText) as HeapSnapshotJson;
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const width = fields.length;
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const sizeAt = fields.indexOf('self_size');
  const edgeCountAt = fields.indexOf('edge_count');
  const kindOf: string[] = [];
  const kinds = new Map<string, HeapType>();
  for (let offset = 0; offset < snapshot.nodes.length; offset += width) {
    const type = types[snapshot.nodes[offset + typeAt]!] ?? 'unknown';
    const name = snapshot.strings[snapshot.nodes[offset + nameAt]!] ?? '';
    const kind = nodeKind(type, name);
    kindOf.push(kind);
    const entry = kinds.get(kind) ?? { name: kind, count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += snapshot.nodes[offset + sizeAt]!;
    kinds.set(kind, entry);
  }
  const retainers = new Map<string, number>();
  const edgeFields = snapshot.snapshot.meta.edge_fields;
  const edgeTypes = snapshot.snapshot.meta.edge_types?.[0];
  if (snapshot.edges && edgeFields && edgeTypes && edgeCountAt >= 0) {
    const edgeWidth = edgeFields.length;
    const edgeTypeAt = edgeFields.indexOf('type');
    const edgeNameAt = edgeFields.indexOf('name_or_index');
    const toAt = edgeFields.indexOf('to_node');
    let edge = 0;
    for (let node = 0; node < kindOf.length; node += 1) {
      const count = snapshot.nodes[node * width + edgeCountAt]!;
      for (let i = 0; i < count; i += 1, edge += edgeWidth) {
        const type = edgeTypes[snapshot.edges[edge + edgeTypeAt]!] ?? 'unknown';
        if (type === 'weak' || type === 'shortcut') continue;
        const raw = snapshot.edges[edge + edgeNameAt]!;
        const name = type === 'element' || type === 'hidden' ? '' : (snapshot.strings[raw] ?? '');
        // V8's own bookkeeping (hidden classes, code, strings, prototypes) holds most edges and says nothing about the app.
        const target = kindOf[snapshot.edges[edge + toAt]! / width]!;
        if (target.startsWith('(') || name === '__proto__') continue;
        const key = `${target} <- ${kindOf[node]}.${edgeLabel(type, name)}`;
        retainers.set(key, (retainers.get(key) ?? 0) + 1);
      }
    }
  }
  return { types: kinds, retainers };
}

/** Sums a V8 heap snapshot's nodes by kind. Self sizes only, so the sums add up to the heap. */
export function heapTypes(snapshotText: string): Map<string, HeapType> {
  return summarizeHeap(snapshotText).types;
}

/** The holder paths whose reference count grew most from `before` to `after`. */
export function growingRetainers(before: Map<string, number>, after: Map<string, number>, top: number): Array<{ path: string; count: number; growth: number }> {
  return [...after]
    .map(([path, count]) => ({ path, count, growth: count - (before.get(path) ?? 0) }))
    .filter((row) => row.growth > 0)
    .sort((a, b) => b.growth - a.growth)
    .slice(0, top);
}

export interface HeapTypeGrowth extends HeapType {
  countGrowth: number;
  bytesGrowth: number;
}

/** The kinds whose bytes grew most from `before` to `after`, largest growth first. */
export function growingHeapTypes(before: Map<string, HeapType>, after: Map<string, HeapType>, top: number): HeapTypeGrowth[] {
  return [...after.values()]
    .map((entry) => {
      const earlier = before.get(entry.name) ?? { count: 0, bytes: 0 };
      return { ...entry, countGrowth: entry.count - earlier.count, bytesGrowth: entry.bytes - earlier.bytes };
    })
    .filter((entry) => entry.bytesGrowth > 0)
    .sort((a, b) => b.bytesGrowth - a.bytesGrowth)
    .slice(0, top);
}
