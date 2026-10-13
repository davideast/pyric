/**
 * The denials a repro file recorded, grouped by what was denied and why.
 *
 * A denial is a listener's `snap` frame or an operation's failed `res` frame
 * whose error carries `denialContext`. The frame names no instance, so each is
 * joined to the request that opened it: the `sub` frame with the same session
 * and subscription id, or the `in` operation with the same session and id.
 */
import type { ReproFile } from './format.js';

export type DenialService = 'rtdb' | 'firestore' | 'storage';

export interface DenialGroup {
  service: DenialService;
  /** The named RTDB instance; absent for the default instance and other services. */
  instance?: string;
  /** The rule node that decided (`/rooms/$roomId`), else the denied path. */
  path: string;
  rule?: string;
  count: number;
  firstAt: number;
  lastAt: number;
  identities: string[];
  trace: string[];
}

export interface DenialFilter {
  /** Keep denials recorded at or after this time, in milliseconds since the epoch. */
  sinceAt?: number;
  service?: DenialService;
}

type Frame = Record<string, unknown>;

const KEY_SEPARATOR = '\x00';

function asRecord(value: unknown): Frame | null {
  return value !== null && typeof value === 'object' ? (value as Frame) : null;
}

/** The instance a request frame addressed, whether an operation or a registration. */
function frameInstance(frame: Frame): string | undefined {
  const target = asRecord(frame.target);
  const named = target === null ? frame.instance : target.instance;
  return typeof named === 'string' && named.length > 0 ? named : undefined;
}

/** The denial context and request key a reply frame carries, or null when it is no denial. */
function denialOf(frame: Frame): { context: Frame; key: string } | null {
  let error: unknown;
  let key: unknown;
  if (frame.t === 'snap') {
    error = asRecord(frame.value)?.__error;
    key = frame.subId;
  } else if (frame.t === 'res' && frame.ok === false) {
    error = frame.error;
    key = frame.id;
  }
  const context = asRecord(asRecord(error)?.denialContext);
  if (context === null || typeof key !== 'string') return null;
  return { context, key };
}

export function listDenials(repro: ReproFile, filter: DenialFilter): DenialGroup[] {
  const requests = new Map<string, Frame>();
  for (const [session, frames] of Object.entries(repro.base.subscriptions ?? {})) {
    for (const frame of frames) requests.set(`${session}${KEY_SEPARATOR}${String((frame as unknown as Frame).subId)}`, frame as unknown as Frame);
  }
  const groups = new Map<string, DenialGroup>();
  for (const entry of repro.entries) {
    if (entry.kind === 'in') {
      const frame = entry.frame as unknown as Frame;
      const key = frame.t === 'sub' ? frame.subId : frame.id;
      if (typeof key === 'string') requests.set(`${entry.session}${KEY_SEPARATOR}${key}`, frame);
      continue;
    }
    if (entry.kind !== 'out') continue;
    const denial = denialOf(entry.frame as unknown as Frame);
    if (denial === null) continue;
    const { context } = denial;
    const engine = context.engine;
    const isFirestore = engine === undefined || engine === 'firestore';
    if (engine !== 'rtdb' && engine !== 'storage' && !isFirestore) continue;
    const service: DenialService = isFirestore ? 'firestore' : engine;
    if (filter.service !== undefined && filter.service !== service) continue;
    if (filter.sinceAt !== undefined && entry.at < filter.sinceAt) continue;
    const request = requests.get(`${entry.session}${KEY_SEPARATOR}${denial.key}`);
    const instance = service === 'rtdb' && request !== undefined ? frameInstance(request) : undefined;
    const requestPath = asRecord(context.request)?.path;
    const path = typeof context.matchedPath === 'string' ? context.matchedPath : String(requestPath ?? '');
    const rule = typeof context.matchedRule === 'string' ? context.matchedRule : undefined;
    const groupKey = [service, instance ?? '', path, rule ?? ''].join(KEY_SEPARATOR);
    const uid = asRecord(context.auth)?.uid;
    const identity = typeof uid === 'string' ? uid : 'anonymous';
    let group = groups.get(groupKey);
    if (group === undefined) {
      const reasons = Array.isArray(context.reasons) ? context.reasons.map(String) : [];
      group = { service, path, count: 0, firstAt: entry.at, lastAt: entry.at, identities: [], trace: reasons };
      if (instance !== undefined) group.instance = instance;
      if (rule !== undefined) group.rule = rule;
      groups.set(groupKey, group);
    }
    group.count += 1;
    group.lastAt = Math.max(group.lastAt, entry.at);
    if (!group.identities.includes(identity)) group.identities.push(identity);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

export function formatDenials(groups: DenialGroup[]): string {
  if (groups.length === 0) return 'No denials recorded.\n';
  const blocks = groups.map((group) => {
    const head = [group.service, group.instance, group.path].filter((part) => part !== undefined).join(' ');
    const lines = [
      `${head}: ${group.count} denial${group.count === 1 ? '' : 's'}`,
      `  first ${new Date(group.firstAt).toISOString()}, last ${new Date(group.lastAt).toISOString()}`,
      `  identities: ${group.identities.join(', ')}`,
    ];
    if (group.rule !== undefined) lines.push(`  rule: ${group.rule}`);
    for (const reason of group.trace) lines.push(`  trace: ${reason}`);
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}
