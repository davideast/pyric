/**
 * Per-client local cache and offline mutation overlay for `pyric/firestore`:
 * warmed paths emit `{ fromCache: true }` before `{ fromCache: false }` (#1355)
 * and offline writes stage locally until `enableNetwork` reconnects (FW-17).
 */
import { Timestamp } from 'pyric/rules/internal';
import type { DocumentData } from './local-state.js';
import { applyMerge, applyUpdate } from './field-merge.js';
import { executeQuery, type QueryScope } from './query-execution.js';
import { compareDocumentPaths } from './query-value-order.js';
import {
  buildDocumentSnapshot,
  buildQuerySnapshot,
  type DocumentSnapshot,
  type QuerySnapshot,
  type SnapshotMetadata,
} from './snapshot-listeners.js';
import { partitionDeletes, resolveValueTree } from './value-resolver.js';
import {
  capturePendingServerTimestamps,
  recordPendingServerTimestamps,
} from './pending-server-timestamps.js';

export type OfflineMutation =
  | {
      readonly kind: 'set';
      readonly path: string;
      readonly data: DocumentData;
      readonly merge?: boolean;
      readonly mergeFields?: readonly string[];
    }
  | { readonly kind: 'update'; readonly path: string; readonly data: DocumentData }
  | { readonly kind: 'delete'; readonly path: string };

interface StagedWriteEntry {
  readonly id: number;
  readonly mutations: readonly OfflineMutation[];
}

function matchesScope(path: string, scope: QueryScope): boolean {
  if (scope.kind === 'collection-group') {
    const parts = path.split('/');
    return parts.length % 2 === 0 && parts[parts.length - 2] === scope.collectionId;
  }
  const prefix = `${scope.path}/`;
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
}

export class ClientOfflineOverlay {
  private readonly baseDocs = new Map<string, DocumentData | null>();
  private readonly warmExistingPaths = new Set<string>();
  private readonly staged: StagedWriteEntry[] = [];
  private nextMutationId = 1;

  recordOnlineDoc(path: string, data: DocumentData | null): void {
    this.baseDocs.set(path, data);
    if (data !== null) {
      this.warmExistingPaths.add(path);
    } else {
      this.warmExistingPaths.delete(path);
    }
  }

  markWarmPath(path: string, readStore?: (docPath: string) => DocumentData | null): void {
    if (path.length === 0) return;
    if (readStore !== undefined) {
      const stored = readStore(path);
      this.recordOnlineDoc(path, stored);
      return;
    }
    this.warmExistingPaths.add(path);
  }

  markDeletedPath(path: string): void {
    this.baseDocs.set(path, null);
    this.warmExistingPaths.delete(path);
  }

  isDocWarm(path: string): boolean {
    return this.warmExistingPaths.has(path);
  }

  isScopeWarm(scope: QueryScope): boolean {
    for (const path of this.warmExistingPaths) {
      if (matchesScope(path, scope)) return true;
    }
    return false;
  }

  stageMutations(mutations: readonly OfflineMutation[]): number {
    const id = this.nextMutationId;
    this.nextMutationId += 1;
    this.staged.push({ id, mutations });
    return id;
  }

  clearMutations(id: number): void {
    const idx = this.staged.findIndex((entry) => entry.id === id);
    if (idx >= 0) this.staged.splice(idx, 1);
  }

  hasPendingPath(path: string): boolean {
    return this.staged.some((entry) => entry.mutations.some((m) => m.path === path));
  }

  projectDoc(path: string): {
    readonly known: boolean;
    readonly data: DocumentData | null;
    readonly hasPendingWrites: boolean;
  } {
    let known = this.baseDocs.has(path);
    let current: DocumentData | null = this.baseDocs.get(path) ?? null;
    let hasPendingWrites = false;
    const serverTime = Timestamp.fromMillis(Date.now());
    for (const entry of this.staged) {
      for (const mutation of entry.mutations) {
        if (mutation.path !== path) continue;
        known = true;
        hasPendingWrites = true;
        if (mutation.kind === 'delete') {
          current = null;
          continue;
        }
        if (mutation.kind === 'update') {
          if (current === null) continue;
          const resolved = resolveValueTree(mutation.data, { path, method: 'update', prior: current, serverTime });
          const nextDoc = applyUpdate(current, resolved);
          recordPendingServerTimestamps(
            nextDoc,
            capturePendingServerTimestamps({ method: 'update', data: mutation.data }, current),
          );
          current = nextDoc;
          continue;
        }
        const resolved = resolveValueTree(mutation.data, { path, method: 'set', prior: current, serverTime });
        const isMerge = mutation.merge === true || mutation.mergeFields !== undefined;
        let nextDoc: DocumentData;
        let mergeSpec: unknown = false;
        if (isMerge) {
          nextDoc = applyMerge(current ?? {}, resolved, mutation.mergeFields);
          if (mutation.merge === true) {
            mergeSpec = true;
          } else if (mutation.mergeFields !== undefined) {
            mergeSpec = { mergeFields: mutation.mergeFields };
          }
        } else {
          nextDoc = partitionDeletes(resolved).writes;
        }
        recordPendingServerTimestamps(
          nextDoc,
          capturePendingServerTimestamps({ method: 'set', data: mutation.data, merge: mergeSpec }, current),
        );
        current = nextDoc;
      }
    }
    return { known, data: current, hasPendingWrites };
  }

  buildOfflineDocSnapshot(path: string): DocumentSnapshot {
    const projected = this.projectDoc(path);
    const meta: SnapshotMetadata = Object.freeze({
      fromCache: true,
      hasPendingWrites: projected.hasPendingWrites,
    });
    return buildDocumentSnapshot(path, projected.data, meta);
  }

  buildOfflineQuerySnapshot(
    scope: QueryScope,
    execution: Parameters<typeof executeQuery>[1] | undefined,
    excludesMetadataChanges: boolean,
    prevDocs?: { path: string; data: DocumentData }[],
  ): { readonly snapshot: QuerySnapshot; readonly docs: { path: string; data: DocumentData }[] } {
    const allPaths = new Set<string>(this.baseDocs.keys());
    for (const entry of this.staged) {
      for (const m of entry.mutations) allPaths.add(m.path);
    }
    const rows: { path: string; data: DocumentData }[] = [];
    for (const path of Array.from(allPaths).sort(compareDocumentPaths)) {
      if (!matchesScope(path, scope)) continue;
      const projected = this.projectDoc(path);
      if (projected.data !== null) rows.push({ path, data: projected.data });
    }
    let matched = rows;
    if (execution !== undefined) matched = executeQuery(rows, execution);
    const pendingPaths = new Set<string>();
    for (const row of matched) {
      if (this.hasPendingPath(row.path)) pendingPaths.add(row.path);
    }
    const meta: SnapshotMetadata = Object.freeze({ fromCache: true, hasPendingWrites: pendingPaths.size > 0 });
    let queryPath: string;
    if (scope.kind === 'collection') {
      queryPath = scope.path;
    } else {
      queryPath = scope.collectionId;
    }
    const snapshot = buildQuerySnapshot({ path: queryPath }, matched, { excludesMetadataChanges }, prevDocs, meta, pendingPaths, pendingPaths);
    return { snapshot, docs: matched };
  }
}
