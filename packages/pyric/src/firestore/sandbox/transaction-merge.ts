/**
 * Item 1.3 — Same-path queued-write collapse.
 *
 * `TransactionContext` queues writes append-only (Item 1.2). Before
 * commit, ops at the same path collapse into a single operation so the
 * existing `LocalState.applyBatch` can run rules-eval + apply atomically
 * without per-call divergence.
 *
 * Probe 0.D verified `update + update` merges fields (last-wins per
 * field, earlier-but-non-overlapping fields preserved). The other
 * combinations are extrapolated from Admin SDK semantics:
 *
 *   set    + set        → second `set` wins (overwrite semantics).
 *   set    + update     → `set` with `{ ...set.data, ...update.data }`.
 *   set    + delete     → `delete` wins (the set never observable).
 *   create + update     → `create` with `{ ...create.data, ...update.data }`.
 *   create + set        → `set` wins (set overwrites, semantically a
 *                         fresh create-or-replace).
 *   create + delete     → `delete` wins (final state is gone).
 *   update + update     → ✅ probed: merged data.
 *   update + set        → `set` wins (set replaces entirely).
 *   update + delete     → `delete` wins.
 *   delete + ANYTHING   → THROW. Probe didn't cover; safer to error
 *                         than guess. Decisions Log: "delete + write
 *                         merge unprobed; v1 throws ambiguous".
 *
 * Output is `LocalState.BatchOperation[]` directly — that's what the
 * commit path (Item 2) feeds into `applyBatch`. Same-path entries
 * collapse into one entry; different paths preserve order of first
 * appearance (insertion order in the path map).
 */
import type { BatchOperation, DocumentData } from './local-state.js';
import type { QueuedWrite } from './transaction-types.js';

/**
 * Thrown when the queue contains a `delete` followed by another write
 * at the same path. The combination is unprobed; v1 errors instead of
 * guessing. The wrapper in the commit path (Item 2) translates this
 * to a `FirestoreSimError { code: 'failed-precondition' }` with a
 * message naming the unprobed combo.
 */
export class AmbiguousPostDeleteWriteError extends Error {
  readonly path: string;
  readonly secondMethod: string;
  constructor(path: string, secondMethod: string) {
    super(
      `Queued ${secondMethod} on '${path}' after a delete in the same ` +
      `transaction. This combination is unprobed against production ` +
      `Firestore; refusing to guess. Either drop the delete or split ` +
      `into two transactions.`,
    );
    this.name = 'AmbiguousPostDeleteWriteError';
    this.path = path;
    this.secondMethod = secondMethod;
  }
}

/**
 * Collapse the per-path queue into one `BatchOperation` per path.
 *
 * - Iterates writes in queue order.
 * - For each path, maintains the "effective op" (method + accumulated
 *   data) and folds in subsequent writes per the table above.
 * - Throws `AmbiguousPostDeleteWriteError` on `delete + anything`.
 */
export function mergeQueuedWrites(writes: readonly QueuedWrite[]): BatchOperation[] {
  // Insertion-ordered map keeps the output stable for callers that
  // care about ordering across paths (none today, but cheap to preserve).
  const byPath = new Map<string, BatchOperation>();

  for (const w of writes) {
    const prior = byPath.get(w.path);
    if (prior === undefined) {
      byPath.set(w.path, toBatchOp(w));
      continue;
    }

    if (prior.method === 'delete') {
      throw new AmbiguousPostDeleteWriteError(w.path, w.method);
    }

    byPath.set(w.path, fold(prior, w));
  }

  return Array.from(byPath.values());
}

/** Convert a single queued write to its initial `BatchOperation` shape. */
function toBatchOp(w: QueuedWrite): BatchOperation {
  if (w.method === 'delete') {
    return { method: 'delete', path: w.path };
  }
  // set / create / update all carry data; queue invariant.
  if (w.data === undefined) {
    throw new Error(
      `internal: queued ${w.method} on ${w.path} has no data — ` +
      `Transaction class invariant violated`,
    );
  }
  return { method: w.method, path: w.path, data: w.data };
}

/**
 * Fold a new queued write into an existing same-path effective op.
 * Pre: `prior.method !== 'delete'` (caller checked).
 */
function fold(prior: BatchOperation, next: QueuedWrite): BatchOperation {
  switch (next.method) {
    case 'delete':
      // Anything-then-delete: final state is gone.
      return { method: 'delete', path: next.path };

    case 'set': {
      // Anything-then-set: set replaces entirely. The earlier op is
      // semantically erased (Admin's set is overwrite).
      const data = requireData(next);
      return { method: 'set', path: next.path, data };
    }

    case 'update': {
      // Merge update fields onto the prior payload. Last-wins per
      // field; earlier non-overlapping fields preserved (probe 0.D).
      const updateData = requireData(next);
      const priorData = prior.data ?? {};
      const merged = { ...priorData, ...updateData };
      // Method stays the same as prior — set+update keeps `set`,
      // create+update keeps `create`, update+update stays `update`.
      // This preserves the "structural failure" semantics: a `create`
      // that's later updated still throws `already-exists` if the doc
      // exists at commit, which is what production would do.
      return { method: prior.method, path: next.path, data: merged };
    }

    case 'create': {
      // create-after-anything-non-delete is unusual but well-defined:
      // the prior op already established intent, then create adds a
      // fail-on-exists guard. We honor the most recent intent — if
      // someone queued `update` then `create`, the final intent is
      // create-with-merged-data. This is consistent with the
      // update-after-create case and avoids a third "ambiguous" throw.
      const createData = requireData(next);
      const priorData = prior.data ?? {};
      const merged = { ...priorData, ...createData };
      return { method: 'create', path: next.path, data: merged };
    }
  }
}

function requireData(w: QueuedWrite): DocumentData {
  if (w.data === undefined) {
    throw new Error(
      `internal: queued ${w.method} on ${w.path} has no data — ` +
      `Transaction class invariant violated`,
    );
  }
  return w.data;
}
