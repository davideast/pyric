/**
 * What every live mode view shows beside its rows, so the host, the chip and
 * Studio read it one way: the project line, the warning when the app's
 * Firebase config names another project than the one the host was started
 * for, and the count of billed calls.
 *
 * The host keeps the status (the `live` field of its health report) and
 * every view reads it there, so two views never disagree and a view that
 * trims its history keeps the count.
 *
 * The count is of calls production answered with success: each Firestore
 * read and write, and each snapshot delivered to a listener. A cache read
 * never reaches production, and Auth calls are not billed per call, so
 * neither is counted. A transaction counts as one write, however many
 * documents it reads and writes.
 */
import type { ObservedCall } from '../types/observed-call.js';

export type BilledCallKind = 'read' | 'write' | 'delivery';

export interface BilledCallCount {
  readonly reads: number;
  readonly writes: number;
  readonly deliveries: number;
}

/** A live host's status, as its health report carries it. Absent on a sandbox host. */
export interface LiveHostStatus {
  /** The project the app's calls go to: the projects its Firebase config named, else the host's own. */
  readonly projectId: string;
  /** The project the host was started for, from the app's Firebase project settings. */
  readonly configProjectId: string;
  /** Where the host's project came from, as a developer names it: `.firebaserc`, `firebase use`. */
  readonly configSource: string;
  /** Every project the app's Firebase config named on a call, in the order the host saw them. */
  readonly appProjectIds: readonly string[];
  readonly billed: BilledCallCount;
}

/** The line every live view shows for as long as the host runs. */
export function liveLabel(projectId: string): string {
  return `Live: ${projectId}`;
}

/** The projects the app's calls named that differ from the host's, or none. */
function otherProjects(status: Pick<LiveHostStatus, 'appProjectIds' | 'configProjectId'>): string[] {
  return status.appProjectIds.filter((projectId) => projectId !== status.configProjectId);
}

/**
 * The warning a live view shows when the app's Firebase config names another
 * project than the host's: `Your Firebase config says prod; .firebaserc says
 * staging.` Null when they agree.
 */
export function liveMismatchLine(status: Pick<LiveHostStatus, 'appProjectIds' | 'configProjectId' | 'configSource'>): string | null {
  const isMismatch = otherProjects(status).length > 0;
  if (!isMismatch) return null;
  return `Your Firebase config says ${status.appProjectIds.join(', ')}; ${status.configSource} says ${status.configProjectId}.`;
}

/** The label's project: the projects the app's calls named, else the host's. */
export function liveProjectOf(appProjectIds: readonly string[], configProjectId: string): string {
  return appProjectIds.length === 0 ? configProjectId : appProjectIds.join(', ');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readCount(value: unknown): BilledCallCount | null {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return null;
  const reads: unknown = Reflect.get(value, 'reads');
  const writes: unknown = Reflect.get(value, 'writes');
  const deliveries: unknown = Reflect.get(value, 'deliveries');
  const isValid = isCount(reads) && isCount(writes) && isCount(deliveries);
  return isValid ? { reads, writes, deliveries } : null;
}

function isProjectName(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function readProjects(value: unknown): string[] | null {
  const isList = Array.isArray(value) && value.every(isProjectName);
  return isList ? [...(value as string[])] : null;
}

/** The live status in a `/__pyric/health` report, or null for a sandbox host. */
export function readLiveHostStatus(health: unknown): LiveHostStatus | null {
  const isReport = typeof health === 'object' && health !== null;
  if (!isReport) return null;
  const live: unknown = Reflect.get(health, 'live');
  const isLive = typeof live === 'object' && live !== null;
  if (!isLive) return null;
  const projectId: unknown = Reflect.get(live, 'projectId');
  const configProjectId: unknown = Reflect.get(live, 'configProjectId');
  const configSource: unknown = Reflect.get(live, 'configSource');
  const appProjectIds = readProjects(Reflect.get(live, 'appProjectIds'));
  const billed = readCount(Reflect.get(live, 'billed'));
  const hasFields = isProjectName(projectId) && isProjectName(configProjectId) && isProjectName(configSource);
  if (!hasFields || appProjectIds === null || billed === null) return null;
  return { projectId, configProjectId, configSource, appProjectIds, billed };
}

const FIRESTORE_KINDS: ReadonlyMap<string, BilledCallKind> = new Map<string, BilledCallKind>([
  ['getDoc', 'read'],
  ['getDocs', 'read'],
  ['getDocFromServer', 'read'],
  ['getDocsFromServer', 'read'],
  ['getCountFromServer', 'read'],
  ['getAggregateFromServer', 'read'],
  ['setDoc', 'write'],
  ['updateDoc', 'write'],
  ['deleteDoc', 'write'],
  ['addDoc', 'write'],
  ['runTransaction', 'write'],
  ['onSnapshot', 'delivery'],
  ['onSnapshotResume', 'delivery'],
]);

/** The billed kind of an observed call, or null for one production did not bill. */
export function billedCallKind(call: Pick<ObservedCall, 'service' | 'method' | 'outcome'>): BilledCallKind | null {
  const succeeded = call.outcome.status === 'ok';
  const isFirestore = call.service === 'firestore';
  if (!succeeded || !isFirestore) return null;
  return FIRESTORE_KINDS.get(call.method) ?? null;
}

export interface BilledCallCounter {
  add(kind: BilledCallKind): void;
  count(): BilledCallCount;
}

/** The host's running count. */
export function createBilledCallCounter(): BilledCallCounter {
  let reads = 0;
  let writes = 0;
  let deliveries = 0;
  return {
    add(kind) {
      if (kind === 'read') reads += 1;
      if (kind === 'write') writes += 1;
      if (kind === 'delivery') deliveries += 1;
    },
    count: () => ({ reads, writes, deliveries }),
  };
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The count as every view writes it: `2 reads, 0 writes, 1 listener delivery`. */
export function billedCallSummary(count: BilledCallCount): string {
  return [
    counted(count.reads, 'read', 'reads'),
    counted(count.writes, 'write', 'writes'),
    counted(count.deliveries, 'listener delivery', 'listener deliveries'),
  ].join(', ');
}
