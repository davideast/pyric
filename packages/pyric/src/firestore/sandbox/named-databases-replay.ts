/**
 * Replay write events onto a named Firestore database's `LocalEnvironment`,
 * mirroring `packages/pyric/src/sandbox/branches/engine.ts` (`apply`) so
 * `consumedRequestIndices`, `result === 'allow'`, `groupId` atomic batches,
 * `autoId` path aliases, and ValueCodec/sentinel rehydration behave identically
 * to `(default)`.
 */
import type { Sandbox, SandboxEvent, WriteSandboxEvent } from 'pyric/sandbox';
import { Timestamp } from 'pyric/rules/internal';
import { getClock } from '../../sandbox/internal/index.js';
import { batchMethodOf, resolveReplayWriteData } from '../../sandbox/replay/index.js';
import {
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getDatabaseEnv,
} from './named-databases.js';
import type { BatchOperationInput } from './writes.js';

type DocData = Record<string, unknown>;

function eventNamedFirestoreDatabase(event: SandboxEvent): string | undefined {
  const direct = (event as { database?: unknown }).database;
  if (typeof direct === 'string' && direct.length > 0 && direct !== DEFAULT_FIRESTORE_DATABASE) {
    return direct;
  }
  const detailDb = (event as { detail?: { database?: unknown } }).detail?.database;
  if (
    typeof detailDb === 'string' &&
    detailDb.length > 0 &&
    detailDb !== DEFAULT_FIRESTORE_DATABASE
  ) {
    return detailDb;
  }
  return undefined;
}

function groupAt(events: readonly WriteSandboxEvent[], index: number): WriteSandboxEvent[] {
  const first = events[index];
  if (first === undefined || first.groupId === undefined) return [];
  const groupId = first.groupId;
  const group: WriteSandboxEvent[] = [];
  for (let at = index; at < events.length; at += 1) {
    const entry = events[at]!;
    if (entry.groupId !== groupId) break;
    group.push(entry);
  }
  return group;
}

function executionFor(
  write: WriteSandboxEvent,
  path: string,
  data: DocData | undefined,
  requestTime: Timestamp,
): {
  method: WriteSandboxEvent['method'];
  path: string;
  auth: WriteSandboxEvent['auth'];
  data?: DocData;
  merge?: WriteSandboxEvent['merge'];
  bypassRules?: boolean;
  requestTime: Timestamp;
} {
  let method: WriteSandboxEvent['method'] = write.method;
  if (write.method === 'update' && write.updateMask === undefined && write.merge === undefined) {
    method = 'set';
  }
  const execution: {
    method: WriteSandboxEvent['method'];
    path: string;
    auth: WriteSandboxEvent['auth'];
    data?: DocData;
    merge?: WriteSandboxEvent['merge'];
    bypassRules?: boolean;
    requestTime: Timestamp;
  } = { method, path, auth: write.auth, requestTime };
  if (data !== undefined) execution.data = data;
  if (write.merge !== undefined) execution.merge = write.merge;
  if (write.detail?.admin === true) execution.bypassRules = true;
  return execution;
}

/** Replay all writes targeting `databaseId` inside `allEvents` onto `sandbox`. */
export function replayNamedFirestoreEventsForDatabase(
  sandbox: Sandbox,
  databaseId: string,
  allEvents: readonly SandboxEvent[],
): void {
  const scopedEvents = allEvents.filter(
    (event) => eventNamedFirestoreDatabase(event) === databaseId,
  );
  const writes = scopedEvents.filter(
    (event): event is WriteSandboxEvent => event.kind === 'write',
  );
  if (writes.length === 0) return;

  declareFirestoreDatabase(sandbox, databaseId);
  const env = getDatabaseEnv(sandbox, databaseId);
  const clock = getClock(sandbox);
  const priorClock = clock.capture();
  let clockPinned = false;
  const consumedRequestIndices = new Set<number>();
  const pathAliases = new Map<string, string>();

  const remap = (path: string): string => {
    for (const [originalPath, replayedPath] of pathAliases) {
      if (path === originalPath) return replayedPath;
      if (path.startsWith(`${originalPath}/`)) {
        return replayedPath + path.slice(originalPath.length);
      }
    }
    return path;
  };
  const pinClockTo = (write: WriteSandboxEvent): void => {
    clock.set(write.requestTime.seconds * 1000 + Math.floor(write.requestTime.nanoseconds / 1e6));
    clockPinned = true;
  };
  const dataFor = (write: WriteSandboxEvent): DocData | undefined =>
    resolveReplayWriteData(write, scopedEvents, consumedRequestIndices);

  try {
    for (let index = 0; index < writes.length; ) {
      const write = writes[index]!;
      const group = groupAt(writes, index);
      if (group.length > 0) {
        pinClockTo(write);
        const existsInGroup = new Map<string, boolean>();
        const operations: BatchOperationInput[] = group.map((event) => {
          const targetPath = remap(event.path);
          const method = batchMethodOf(event, targetPath, existsInGroup);
          const operation: BatchOperationInput = { method, path: targetPath };
          if (event.method !== 'delete') {
            const data = dataFor(event);
            if (data !== undefined) operation.data = data;
          }
          if (event.merge !== undefined) operation.merge = event.merge;
          return operation;
        });
        try {
          env.batch(operations, group[0]!.auth, group[0]!.detail?.admin === true);
        } catch {
          // Denied or failed batches surface later as divergences in diff().
        }
        index += group.length;
        continue;
      }
      index += 1;

      const data = dataFor(write);
      const requestTime = new Timestamp(write.requestTime.seconds, write.requestTime.nanoseconds);
      const bypassRules = write.detail?.admin === true;

      if (write.autoId) {
        const targetPath = remap(write.path);
        pinClockTo(write);
        if (!(targetPath in env.snapshot())) {
          try {
            env.execute(executionFor(write, targetPath, data, requestTime));
          } catch {
            // Keep applying subsequent writes so diff() surfaces the divergence.
          }
          continue;
        }
        const collection = targetPath.slice(0, targetPath.lastIndexOf('/'));
        try {
          const { path: mintedPath, result } = env.createWithAutoId(
            collection,
            (data ?? {}) as DocData,
            write.auth,
            bypassRules,
          );
          if (result.allowed) {
            pathAliases.set(write.path, mintedPath);
          }
        } catch {
          // Keep applying subsequent writes so diff() surfaces the divergence.
        }
        continue;
      }

      try {
        env.execute(executionFor(write, remap(write.path), data, requestTime));
      } catch {
        // Denied or failed writes surface later as divergences in diff().
      }
    }
  } finally {
    if (clockPinned) clock.restore(priorClock);
  }
}
