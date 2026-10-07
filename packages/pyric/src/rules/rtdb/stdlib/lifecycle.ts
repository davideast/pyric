/**
 * `lifecycle`: which fields a write may change, ownership of a record, and
 * write-once and no-delete records.
 *
 * Placement: every builder reads `data` and `newData` of the record node, so
 * it goes in the record's `.write` (or `.validate`; see each builder). On an
 * update of one child, `newData` at the record is the merged record after the
 * write, so the same rule covers a set of the record and an update of some of
 * its fields.
 *
 * RTDB rules cannot list a node's children, so the changed-field checks take
 * the record's field list and compare each field before and after. Pair them
 * with a closed shape (`validation.shape`) so no unlisted field can be
 * written. Compare leaf fields only: a field that holds an object is not a
 * value `==` can compare.
 */
import type { Expr } from '../constraints/types.js';
import { all, any, expr, fieldName, not } from '../constraints/compose.js';
import { dataVal, neq, newDataExists, newDataVal } from '../constraints/data.js';
import { authenticated, isNew } from '../constraints/atoms.js';
import { sameAsBefore } from './expr.js';

/** Each listed field holds the same value before and after the write. */
export function unchanged(...fields: string[]): Expr {
  if (fields.length === 0) throw new Error('unchanged: pass at least one field.');
  return all(...fields.map((f) => sameAsBefore(fieldName('unchanged', f))));
}

/**
 * The listed fields keep the value they were created with. A create passes.
 * In `.write`, a delete is refused because the fields become null; in
 * `.validate`, which does not run on a delete, a delete passes.
 */
export function immutableFields(...fields: string[]): Expr {
  return any(isNew(), unchanged(...fields));
}

function checkSubset(builder: string, changed: string[], fields: string[]): string[] {
  for (const f of changed) {
    if (!fields.includes(f)) throw new Error(`${builder}: changed field '${f}' is not in the field list.`);
  }
  return fields.filter((f) => !changed.includes(f));
}

/**
 * Of the record's `fields`, only the ones in `changed` may differ after the
 * write; a listed field may also stay the same. On a create every field
 * changes from null, so combine it with a create rule (`isNew()`).
 */
export function onlyFieldsChanged(changed: string[], fields: string[]): Expr {
  const rest = checkSubset('onlyFieldsChanged', changed, fields);
  return rest.length === 0 ? expr('true') : unchanged(...rest);
}

/** Every field in `changed` differs after the write, and every other field in `fields` is the same. */
export function exactlyChanged(changed: string[], fields: string[]): Expr {
  if (changed.length === 0) throw new Error('exactlyChanged: pass at least one changed field.');
  const rest = checkSubset('exactlyChanged', changed, fields);
  return all(
    ...changed.map((f) => neq(newDataVal(fieldName('exactlyChanged', f)), { $: dataVal(f) })),
    ...(rest.length > 0 ? [unchanged(...rest)] : []),
  );
}

/** The write creates the node: nothing is stored there and something is written. `.write`. */
export const createOnly = (): Expr => all(isNew(), newDataExists());

/** The write leaves a value at the node, so it is not a delete. `.write`. */
export const noDelete = (): Expr => newDataExists();

/**
 * The signed-in user owns the record through `field`, a child holding the
 * owner's uid: a create must name the writer as owner, and only the owner
 * may update the record, without changing the owner, or delete it. `.write`.
 */
export function ownedBy(field: string): Expr {
  const f = fieldName('ownedBy', field);
  const newOwner = newDataVal(f);
  return all(
    authenticated(),
    any(
      all(isNew(), expr(`${newOwner} == auth.uid`)),
      all(expr(`${dataVal(f)} == auth.uid`), any(not(newDataExists()), expr(`${newOwner} == auth.uid`))),
    ),
  );
}
