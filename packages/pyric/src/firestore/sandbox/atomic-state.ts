import type { BatchOperation, BatchResult, DocBacking, DocumentData } from './document-store.js';
import { resolveValueTree, partitionDeletes } from './value-resolver.js';
import { applyUpdate } from './field-merge.js';

/** Validate the ordered writes, apply them, and report each committed version change. */
export function applyAtomicBatch(
  documents: DocBacking,
  operations: BatchOperation[],
  onWrite: (path: string) => void,
): BatchResult {
  // Later operations see earlier creates/deletes without mutating storage.
  const errors: { index: number; error: string }[] = [];
  const projectedExistence = new Map<string, boolean>();
  for (const [index, op] of operations.entries()) {
    const documentExists = projectedExistence.get(op.path) ?? documents.has(op.path);
    switch (op.method) {
      case 'create':
        if (documentExists) {
          errors.push({ index, error: `Document '${op.path}' already exists` });
        }
        projectedExistence.set(op.path, true);
        break;
      case 'update': {
        const documentMissing = !documentExists;
        if (documentMissing) {
          errors.push({ index, error: `Document '${op.path}' does not exist` });
        }
        break;
      }
      case 'delete':
        // Delete-missing is a no-op in production: `WriteBatch.delete`
        // and `Transaction.delete` on an absent doc resolve cleanly,
        // matching the single-op `deleteDoc` contract (matrix row
        // Firestore #39, oracle:
        // packages/conformance/observations/firestore/firestore-deletedoc-missing.json).
        // Apply phase below tolerates the absence via `documents.delete`,
        // which is itself a no-op on a missing key.
        projectedExistence.set(op.path, false);
        break;
      case 'set':
        projectedExistence.set(op.path, true);
        break;
    }
  }

  const hasInvalidOperations = errors.length > 0;
  if (hasInvalidOperations) {
    return { success: false, errors };
  }

  // Capture prior state for all affected documents (for undo)
  const priorStates = new Map<string, DocumentData | null>();
  for (const op of operations) {
    const isFirstWrite = !priorStates.has(op.path);
    if (isFirstWrite) {
      const documentExists = documents.has(op.path);
      let priorData: DocumentData | null = null;
      if (documentExists) priorData = { ...documents.get(op.path) };
      priorStates.set(op.path, priorData);
    }
  }

  // Apply all operations. Each non-delete write routes through the
  // resolver with the correct prior — captured above, so resolution
  // order within the batch sees the same prior the rules saw. Item 2:
  // every non-delete branch partitions DELETE_FIELD markers out via
  // partitionDeletes so they don't leak into storage.
  for (const op of operations) {
    switch (op.method) {
      case 'create': {
        const resolved = resolveValueTree({ ...op.data }, {
          path: op.path,
          method: 'create',
          prior: null,
        });
        const { writes } = partitionDeletes(resolved);
        documents.set(op.path, writes);
        break;
      }
      case 'update': {
        const existing = documents.get(op.path);
        const documentMissing = existing === undefined;
        if (documentMissing) throw new Error(`Validated document '${op.path}' disappeared during atomic application`);
        const resolved = resolveValueTree({ ...op.data }, {
          path: op.path,
          method: 'update',
          prior: existing,
        });
        // FS-B5: dot-path FieldPath expansion + sibling-preserving merge.
        documents.set(op.path, applyUpdate(existing, resolved));
        break;
      }
      case 'set': {
        const priorForSet = priorStates.get(op.path) ?? null;
        const resolved = resolveValueTree({ ...op.data }, {
          path: op.path,
          method: 'set',
          prior: priorForSet,
        });
        const { writes } = partitionDeletes(resolved);
        documents.set(op.path, writes);
        break;
      }
      case 'delete':
        documents.delete(op.path);
        break;
    }
    onWrite(op.path);
  }

  return { success: true, priorStates };
}
