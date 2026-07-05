/**
 * Item 5 — VectorValue converter.
 *
 * Wraps `firebase-admin` `VectorValue` instances into our {@link Vector}
 * wrapper at the write boundary. Without this, the wire encoder would
 * walk the admin VectorValue as a plain object and emit garbage that
 * `discover/wire.ts` cannot recognize as a vector sentinel.
 *
 * Detection strategy — duck typing on the admin SDK shape:
 *   - has a `_values` private member that's an Array of numbers
 *   - exposes a `toArray` function
 *
 * We deliberately don't `instanceof VectorValue` because:
 *   1. The simulator package shouldn't take a hard dependency on
 *      firebase-admin (it's a consumer concern), and
 *   2. Multiple admin SDK copies in a workspace would defeat instanceof.
 *
 * Idempotency: the converter only matches the admin SDK shape, never
 * our own {@link Vector} wrapper (which has no `_values` field and uses
 * a frozen `value` array instead). A second resolver pass is a no-op.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Vector } from 'pyric/rules';

function isNumberArray(a: unknown): a is number[] {
  return Array.isArray(a) && a.every((n) => typeof n === 'number');
}

/**
 * Extract a VectorValue's components, or null if `v` isn't one. The brand is a
 * numeric `_values` AND a `toArray` method: both the firebase web SDK and the
 * admin SDK `VectorValue` expose both, so requiring both is what distinguishes a
 * real vector from a plain object that merely has one of them.
 */
function extractVectorValues(v: unknown): number[] | null {
  if (v === null || typeof v !== 'object') return null;
  // Must NOT be one of our own wrappers; those are already converted.
  if (v instanceof Vector) return null;
  const o = v as Record<string, unknown>;
  if (isNumberArray(o._values) && typeof o.toArray === 'function') return o._values;
  return null;
}

export const vectorValueConverter: ValueConverter = {
  name: 'vector-value',
  convert(value) {
    const values = extractVectorValues(value);
    if (values === null) return KEEP;
    return new Vector(values);
  },
};
