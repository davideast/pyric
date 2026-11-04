/**
 * What every live mode view shows beside its rows, so the chip and Studio
 * read it one way: the project line, from the host's health report, and the
 * running count of billed calls, folded from the observed events the host
 * writes for every client.
 *
 * The count is of calls production answered with success: each Firestore
 * read and write, and each snapshot delivered to a listener. A cache read
 * never reaches production, and Auth calls are not billed per call, so
 * neither is counted.
 */
import type { SandboxEvent } from '../types/events.js';
import { isProductionServed } from './observed-call.js';

/** The host's live status: the project its live clients talk to. Absent on a sandbox host. */
export interface LiveHostStatus {
  readonly projectId: string;
}

/** The line every live view shows for as long as the host runs. */
export function liveLabel(projectId: string): string {
  return `Live: ${projectId}`;
}

/** The live status in a `/__pyric/health` report, or null for a sandbox host. */
export function readLiveHostStatus(health: unknown): LiveHostStatus | null {
  const isReport = typeof health === 'object' && health !== null;
  if (!isReport) return null;
  const live: unknown = Reflect.get(health, 'live');
  const isLive = typeof live === 'object' && live !== null;
  if (!isLive) return null;
  const projectId: unknown = Reflect.get(live, 'projectId');
  const hasProject = typeof projectId === 'string' && projectId !== '';
  return hasProject ? { projectId } : null;
}

export type BilledCallKind = 'read' | 'write' | 'delivery';

export interface BilledCallCount {
  readonly reads: number;
  readonly writes: number;
  readonly deliveries: number;
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

/** The billed kind of an event, or null for one production did not bill or did not serve. */
export function billedCallKind(event: SandboxEvent): BilledCallKind | null {
  const isOperation = event.kind === 'operation';
  if (!isOperation) return null;
  const succeeded = event.production?.outcome.status === 'ok';
  const isObserved = succeeded && isProductionServed(event.rulesDisposition);
  const isFirestore = event.service === 'firestore';
  if (!isObserved || !isFirestore) return null;
  return FIRESTORE_KINDS.get(event.method) ?? null;
}

export interface BilledCallCounter {
  /** Folds a batch of events in. Returns whether the count changed. */
  add(events: readonly SandboxEvent[]): boolean;
  count(): BilledCallCount;
}

/** A running count. An event delivered again, as a reconnect's history is, counts once. */
export function createBilledCallCounter(): BilledCallCounter {
  const counted = new Set<string>();
  let reads = 0;
  let writes = 0;
  let deliveries = 0;
  return {
    add(events) {
      let changed = false;
      for (const event of events) {
        const kind = billedCallKind(event);
        const isNew = kind !== null && !counted.has(event.id);
        if (!isNew) continue;
        counted.add(event.id);
        changed = true;
        if (kind === 'read') reads += 1;
        if (kind === 'write') writes += 1;
        if (kind === 'delivery') deliveries += 1;
      }
      return changed;
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
