// Backwards-compatible opt-in RTDB numeric target entry.
// Delegates directly to the unified RTDB lowering target in ./rtdb.js.
import type { FunctionDef } from '../grammar/FirestoreAST.js';
import { emitRtdbFunctionPredicate, type RtdbSnapshotBinding } from './rtdb.js';

export type NumericSnapshot = Omit<RtdbSnapshotBinding, 'type'>;

export function emitRtdbNumericPredicate(fn: FunctionDef, bindings: Record<string, NumericSnapshot>): string {
  return emitRtdbFunctionPredicate(fn, bindings, 'number');
}
