/**
 * The loaded operation set.
 *
 * The list is not authored here: `generate-manifest.ts` reads this directory
 * and renders `manifest.generated.ts`, and this loader stamps each record with
 * the canonical id its filename carries. A record file therefore never repeats
 * its own id, and adding an operation is one new file with no shared list to
 * edit.
 */
import { OPERATION_RECORDS } from './manifest.generated.js';
import type { Operation } from '../types.js';

function loadOperations(): readonly Operation[] {
  const loaded: Operation[] = [];
  const seen = new Set<string>();
  for (const [id, record] of OPERATION_RECORDS) {
    if (seen.has(id)) throw new Error(`duplicate operation id '${id}'`);
    seen.add(id);
    const prefix = `${record.verb}_${record.service}`;
    if (!id.startsWith(prefix)) {
      throw new Error(`operation '${id}' declares a verb and service reading '${prefix}'`);
    }
    loaded.push({ ...record, id });
  }
  return loaded;
}

/** Every operation, in canonical id order. */
export const OPERATIONS: readonly Operation[] = loadOperations();

/** Every operation by canonical id. */
export const OPERATIONS_BY_ID: ReadonlyMap<string, Operation> = new Map(
  OPERATIONS.map((operation) => [operation.id, operation]),
);

/** One operation by canonical id. Throws when the id is not one of ours. */
export function operationById(id: string): Operation {
  const operation = OPERATIONS_BY_ID.get(id);
  if (!operation) throw new Error(`unknown operation '${id}'`);
  return operation;
}
