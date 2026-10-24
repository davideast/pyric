/**
 * The denials a repro file recorded, grouped by what was denied and why.
 *
 * A denial is a listener's `snap` frame or an operation's failed `res` frame
 * whose error carries `denialContext`. The frame names no instance, so each is
 * joined to the request that opened it: the `sub` frame with the same session
 * and subscription id, or the `in` operation with the same session and id.
 *
 * Storage denials are not listed: a Storage rules error carries no
 * `denialContext`, only the sandbox event does.
 */
import type { ReproFile } from './format.js';
import { requestInstance } from '../worker/request-instance.js';

export type DenialService = 'rtdb' | 'firestore';

export interface DenialGroup {
  service: DenialService;
  /** The named RTDB instance; absent for the default instance and for Firestore. */
  instance?: string;
  /** True for an RTDB denial whose request left the bounded log, so its instance cannot be named. */
  instanceUnknown?: boolean;
  /**
   * What decided: the RTDB rule node (`/rooms/$roomId`), or the Firestore
   * rule's location (`firestore.rules:5:7`). The denied path when neither is known.
   */
  path: string;
  rule?: string;
  /** Each denied path, in the order first denied. */
  paths: string[];
  count: number;
  /** Distinct page loads (client sessions) the denial happened on; an agent's tool calls are not page loads. */
  loads: number;
  firstAt: number;
  lastAt: number;
  identities: string[];
  /** The rule trace of every denial in the group, each line once. */
  trace: string[];
}

export interface DenialFilter {
  /** Keep denials recorded at or after this time, in milliseconds since the epoch. */
  sinceAt?: number;
  service?: DenialService;
}

type Frame = Record<string, unknown>;

const KEY_SEPARATOR = '\x00';
/** The recorder logs an MCP caller's tool calls under a session of its own with this prefix. */
const TOOL_SESSION_PREFIX = 'mcp:';

function asRecord(value: unknown): Frame | null {
  return value !== null && typeof value === 'object' ? (value as Frame) : null;
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

/** The service a denial context belongs to; null for an engine this listing does not read. */
function serviceOf(context: Frame): DenialService | null {
  const engine = context.engine;
  if (engine === 'rtdb') return 'rtdb';
  const isFirestore = engine === undefined || engine === 'firestore';
  return isFirestore ? 'firestore' : null;
}

/** What decided the denial: the rule node or rule location, and the rule. */
function decidingRule(service: DenialService, context: Frame): { at?: string; rule?: string } {
  if (service === 'rtdb') {
    return {
      ...(typeof context.matchedPath === 'string' ? { at: context.matchedPath } : {}),
      ...(typeof context.matchedRule === 'string' ? { rule: context.matchedRule } : {}),
    };
  }
  const rule = asRecord(context.rule);
  if (rule === null) return {};
  const location = typeof rule.citation === 'string'
    ? rule.citation
    : typeof rule.line === 'number' ? `line ${rule.line}` : undefined;
  return {
    ...(location === undefined ? {} : { at: location }),
    ...(typeof rule.expression === 'string' ? { rule: rule.expression } : {}),
  };
}

export function listDenials(repro: ReproFile, filter: DenialFilter): DenialGroup[] {
  const requests = new Map<string, unknown>();
  for (const [session, frames] of Object.entries(repro.base.subscriptions ?? {})) {
    for (const frame of frames) requests.set(`${session}${KEY_SEPARATOR}${String((frame as unknown as Frame).subId)}`, frame);
  }
  const groups = new Map<string, DenialGroup>();
  const loadsByGroup = new Map<string, Set<string>>();
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
    const service = serviceOf(context);
    if (service === null) continue;
    if (filter.service !== undefined && filter.service !== service) continue;
    if (filter.sinceAt !== undefined && entry.at < filter.sinceAt) continue;
    const requestKey = `${entry.session}${KEY_SEPARATOR}${denial.key}`;
    const hasRequest = requests.has(requestKey);
    const instance = service === 'rtdb' ? requestInstance(requests.get(requestKey)) : undefined;
    const instanceUnknown = service === 'rtdb' && !hasRequest;
    const requestPath = asRecord(context.request)?.path;
    const deniedPath = String(requestPath ?? '');
    const decided = decidingRule(service, context);
    const path = decided.at ?? deniedPath;
    const instanceKey = instanceUnknown ? KEY_SEPARATOR : instance ?? '';
    const groupKey = [service, instanceKey, path, decided.rule ?? ''].join(KEY_SEPARATOR);
    const uid = asRecord(context.auth)?.uid;
    const identity = typeof uid === 'string' ? uid : 'anonymous';
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { service, path, paths: [], count: 0, loads: 0, firstAt: entry.at, lastAt: entry.at, identities: [], trace: [] };
      if (instance !== undefined) group.instance = instance;
      if (instanceUnknown) group.instanceUnknown = true;
      if (decided.rule !== undefined) group.rule = decided.rule;
      groups.set(groupKey, group);
    }
    group.count += 1;
    const isPageLoad = !entry.session.startsWith(TOOL_SESSION_PREFIX);
    if (isPageLoad) {
      const loads = loadsByGroup.get(groupKey) ?? new Set<string>();
      loads.add(entry.session);
      loadsByGroup.set(groupKey, loads);
      group.loads = loads.size;
    }
    group.lastAt = Math.max(group.lastAt, entry.at);
    if (!group.identities.includes(identity)) group.identities.push(identity);
    if (!group.paths.includes(deniedPath)) group.paths.push(deniedPath);
    const reasons = Array.isArray(context.reasons) ? context.reasons.map(String) : [];
    for (const reason of reasons) if (!group.trace.includes(reason)) group.trace.push(reason);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

/**
 * The groups as terminal text. `loggedFrom` is the oldest time the host's
 * bounded log still covers, given when it dropped older entries.
 */
export function formatDenials(groups: DenialGroup[], loggedFrom?: number): string {
  const bounded = loggedFrom === undefined
    ? ''
    : `The host keeps a bounded log: these counts start at ${new Date(loggedFrom).toISOString()}.\n`;
  if (groups.length === 0) return `${bounded}No denials recorded.\n`;
  const blocks = groups.map((group) => {
    const instance = group.instanceUnknown ? '(instance unknown)' : group.instance;
    const head = [group.service, instance, group.path].filter((part) => part !== undefined).join(' ');
    const lines = [
      `${head}: ${group.count} denial${group.count === 1 ? '' : 's'} on ${group.loads} page load${group.loads === 1 ? '' : 's'}`,
      `  first ${new Date(group.firstAt).toISOString()}, last ${new Date(group.lastAt).toISOString()}`,
      `  identities: ${group.identities.join(', ')}`,
    ];
    if (group.rule !== undefined) lines.push(`  rule: ${group.rule}`);
    const listsPaths = group.paths.length > 1 || group.paths[0] !== group.path;
    if (listsPaths) lines.push(`  denied: ${group.paths.join(', ')}`);
    for (const reason of group.trace) lines.push(`  trace: ${reason}`);
    return lines.join('\n');
  });
  const tip = '\nTip: After updating rules, run `pyric verify` to replay these captured sessions and confirm your fixes.';
  return `${bounded}${blocks.join('\n\n')}\n${tip}\n`;
}
