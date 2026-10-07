/**
 * Cases for the single-document write projection capture. Each case applies one
 * client write to a seeded document, and each predicate is a rule expression
 * over `request.resource.data` / `resource.data` that is deployed as its own
 * guarded rule. The write is allowed exactly when the predicate holds, so the
 * allow/deny verdict per predicate reads out what the rules engine built for
 * the write. The same table drives the production capture and the sandbox
 * replay, so both sides evaluate identical writes and identical rule text.
 */

export type WriteValue = string | number | boolean | { readonly $deleteField: true };

export type WriteSpec =
  | { readonly kind: 'updateObject'; readonly data: Readonly<Record<string, unknown>> }
  | {
      readonly kind: 'updateFieldPaths';
      readonly entries: readonly { readonly path: readonly string[]; readonly value: WriteValue }[];
    }
  | {
      readonly kind: 'setDoc';
      readonly data: Readonly<Record<string, unknown>>;
      readonly options?: { readonly merge: true } | { readonly mergeFields: readonly string[] };
    };

export interface WritePredicate {
  readonly id: string;
  /** Rule expression. `RRD` stands for `request.resource.data`, `RES` for `resource.data`. */
  readonly expr: string;
}

export interface WriteCase {
  readonly id: string;
  readonly description: string;
  readonly write: WriteSpec;
  readonly predicates: readonly WritePredicate[];
}

export const SEED_DOCUMENT = {
  board: { c1r1: 'a', c2r2: 'b' },
  keep: 1,
} as const;

const DELETE: WriteValue = { $deleteField: true };

const AFFECTED = 'RRD.diff(RES).affectedKeys()';

export const WRITE_CASES: readonly WriteCase[] = [
  {
    id: 'dotted_update',
    description: "updateDoc(ref, {'board.c1r1': 'x'})",
    write: { kind: 'updateObject', data: { 'board.c1r1': 'x' } },
    predicates: [
      { id: 'nested_leaf', expr: "RRD.board.c1r1 == 'x'" },
      { id: 'sibling_kept', expr: "RRD.board.c2r2 == 'b'" },
      { id: 'top_level_kept', expr: 'RRD.keep == 1' },
      { id: 'no_literal_key', expr: "!('board.c1r1' in RRD)" },
      { id: 'literal_key_present', expr: "'board.c1r1' in RRD" },
      { id: 'top_keys_only_board_keep', expr: "RRD.keys().hasOnly(['board', 'keep'])" },
      { id: 'affected_is_board', expr: `${AFFECTED} == ['board'].toSet()` },
      { id: 'affected_has_literal', expr: `${AFFECTED}.hasAny(['board.c1r1'])` },
      { id: 'changed_is_board', expr: "RRD.diff(RES).changedKeys() == ['board'].toSet()" },
      { id: 'added_is_empty', expr: 'RRD.diff(RES).addedKeys() == [].toSet()' },
      { id: 'changed_has_board', expr: "RRD.diff(RES).changedKeys().hasAny(['board'])" },
      { id: 'changed_is_empty', expr: 'RRD.diff(RES).changedKeys() == [].toSet()' },
      { id: 'unchanged_is_keep', expr: "RRD.diff(RES).unchangedKeys() == ['keep'].toSet()" },
      { id: 'resource_unchanged', expr: "RES.board.c1r1 == 'a'" },
    ],
  },
  {
    id: 'literal_dot_field_path',
    description: "updateDoc(ref, new FieldPath('a.b'), 'x')",
    write: { kind: 'updateFieldPaths', entries: [{ path: ['a.b'], value: 'x' }] },
    predicates: [
      { id: 'literal_key_present', expr: "'a.b' in RRD" },
      { id: 'literal_key_value', expr: "RRD['a.b'] == 'x'" },
      { id: 'no_nested_a', expr: "!('a' in RRD)" },
      { id: 'board_kept', expr: "RRD.board.c1r1 == 'a'" },
      { id: 'top_keys_with_literal', expr: "RRD.keys().hasOnly(['board', 'keep', 'a.b'])" },
      { id: 'affected_is_literal', expr: `${AFFECTED} == ['a.b'].toSet()` },
      { id: 'added_is_literal', expr: "RRD.diff(RES).addedKeys() == ['a.b'].toSet()" },
    ],
  },
  {
    id: 'literal_dot_nested_segment',
    description: "updateDoc(ref, new FieldPath('board', 'c1.r1'), 'x')",
    write: { kind: 'updateFieldPaths', entries: [{ path: ['board', 'c1.r1'], value: 'x' }] },
    predicates: [
      { id: 'literal_leaf_value', expr: "RRD.board['c1.r1'] == 'x'" },
      { id: 'sibling_kept', expr: "RRD.board.c1r1 == 'a'" },
      { id: 'no_top_literal', expr: "!('board.c1.r1' in RRD)" },
      { id: 'affected_is_board', expr: `${AFFECTED} == ['board'].toSet()` },
    ],
  },
  {
    id: 'dotted_delete_field',
    description: "updateDoc(ref, {'board.c1r1': deleteField()})",
    write: { kind: 'updateObject', data: { 'board.c1r1': DELETE } },
    predicates: [
      { id: 'leaf_removed', expr: "!('c1r1' in RRD.board)" },
      { id: 'sibling_kept', expr: "RRD.board.c2r2 == 'b'" },
      { id: 'no_literal_key', expr: "!('board.c1r1' in RRD)" },
      { id: 'affected_is_board', expr: `${AFFECTED} == ['board'].toSet()` },
    ],
  },
  {
    id: 'set_merge',
    description: "setDoc(ref, {board: {c1r1: 'x'}, extra: 2}, {merge: true})",
    write: {
      kind: 'setDoc',
      data: { board: { c1r1: 'x' }, extra: 2 },
      options: { merge: true },
    },
    predicates: [
      { id: 'nested_leaf', expr: "RRD.board.c1r1 == 'x'" },
      { id: 'sibling_kept', expr: "RRD.board.c2r2 == 'b'" },
      { id: 'top_level_kept', expr: 'RRD.keep == 1' },
      { id: 'new_field', expr: 'RRD.extra == 2' },
      { id: 'top_keys', expr: "RRD.keys().hasOnly(['board', 'keep', 'extra'])" },
      { id: 'affected_is_board_extra', expr: `${AFFECTED} == ['board', 'extra'].toSet()` },
      { id: 'resource_unchanged', expr: "RES.board.c1r1 == 'a'" },
    ],
  },
  {
    id: 'set_merge_fields',
    description:
      "setDoc(ref, {board: {c1r1: 'x', c2r2: 'zzz'}, ignore: 5}, {mergeFields: ['board.c1r1']})",
    write: {
      kind: 'setDoc',
      data: { board: { c1r1: 'x', c2r2: 'zzz' }, ignore: 5 },
      options: { mergeFields: ['board.c1r1'] },
    },
    predicates: [
      { id: 'listed_leaf_written', expr: "RRD.board.c1r1 == 'x'" },
      { id: 'unlisted_sibling_kept', expr: "RRD.board.c2r2 == 'b'" },
      { id: 'unlisted_top_absent', expr: "!('ignore' in RRD)" },
      { id: 'top_level_kept', expr: 'RRD.keep == 1' },
      { id: 'affected_is_board', expr: `${AFFECTED} == ['board'].toSet()` },
    ],
  },
  {
    id: 'nested_map_replace',
    description: "updateDoc(ref, {board: {c1r1: 'x'}})",
    write: { kind: 'updateObject', data: { board: { c1r1: 'x' } } },
    predicates: [
      { id: 'board_only_new_key', expr: "RRD.board.keys().hasOnly(['c1r1'])" },
      { id: 'sibling_gone', expr: "!('c2r2' in RRD.board)" },
      { id: 'top_level_kept', expr: 'RRD.keep == 1' },
      { id: 'top_keys', expr: "RRD.keys().hasOnly(['board', 'keep'])" },
      { id: 'affected_is_board', expr: `${AFFECTED} == ['board'].toSet()` },
      { id: 'changed_is_board', expr: "RRD.diff(RES).changedKeys() == ['board'].toSet()" },
    ],
  },
  {
    id: 'set_replace',
    description: "setDoc(ref, {board: {c1r1: 'x'}})",
    write: { kind: 'setDoc', data: { board: { c1r1: 'x' } } },
    predicates: [
      { id: 'top_level_gone', expr: "!('keep' in RRD)" },
      { id: 'top_keys_only_board', expr: "RRD.keys().hasOnly(['board'])" },
      { id: 'sibling_gone', expr: "!('c2r2' in RRD.board)" },
      { id: 'affected_is_board_keep', expr: `${AFFECTED} == ['board', 'keep'].toSet()` },
      { id: 'removed_is_keep', expr: "RRD.diff(RES).removedKeys() == ['keep'].toSet()" },
    ],
  },
  {
    id: 'scalar_update',
    description: 'updateDoc(ref, {keep: 3})',
    write: { kind: 'updateObject', data: { keep: 3 } },
    predicates: [
      { id: 'changed_is_keep', expr: "RRD.diff(RES).changedKeys() == ['keep'].toSet()" },
      { id: 'affected_is_keep', expr: `${AFFECTED} == ['keep'].toSet()` },
      { id: 'changed_is_empty', expr: 'RRD.diff(RES).changedKeys() == [].toSet()' },
      { id: 'unchanged_is_board', expr: "RRD.diff(RES).unchangedKeys() == ['board'].toSet()" },
    ],
  },
  {
    id: 'control',
    description: 'updateDoc(ref, {keep: 2}) guarded by constant predicates',
    write: { kind: 'updateObject', data: { keep: 2 } },
    predicates: [
      { id: 'always_true', expr: 'true' },
      { id: 'always_false', expr: 'false' },
    ],
  },
];

export function predicateDocId(caseId: string, predicateId: string): string {
  return `${caseId}__${predicateId}`;
}

export function expandPredicate(expr: string): string {
  return expr.split('RRD').join('request.resource.data').split('RES').join('resource.data');
}

/** Rule block matching every `<case>__<predicate>` document under `wrr`. */
export function writeProjectionRules(): string {
  const lines: string[] = [];
  for (const c of WRITE_CASES) {
    for (const p of c.predicates) {
      lines.push(
        `      allow create, update: if request.auth != null && caseId == '${predicateDocId(c.id, p.id)}' && (${expandPredicate(p.expr)});`,
      );
    }
  }
  return `    match /wrr/{caseId} {\n${lines.join('\n')}\n    }`;
}

export interface WriteSdk {
  updateDoc(ref: unknown, ...args: unknown[]): Promise<void>;
  setDoc(ref: unknown, data: unknown, options?: unknown): Promise<void>;
  deleteField(): unknown;
  FieldPath: new (...segments: string[]) => unknown;
}

function revive(sdk: WriteSdk, value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    if ((value as { $deleteField?: unknown }).$deleteField === true) return sdk.deleteField();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(sdk, v);
    return out;
  }
  return value;
}

export async function applyWrite(sdk: WriteSdk, ref: unknown, write: WriteSpec): Promise<void> {
  switch (write.kind) {
    case 'updateObject':
      return sdk.updateDoc(ref, revive(sdk, write.data));
    case 'updateFieldPaths': {
      const args: unknown[] = [];
      for (const e of write.entries) {
        args.push(new sdk.FieldPath(...e.path), revive(sdk, e.value));
      }
      const [first, second, ...rest] = args;
      return sdk.updateDoc(ref, first, second, ...rest);
    }
    case 'setDoc': {
      const data = revive(sdk, write.data);
      if (!write.options) return sdk.setDoc(ref, data);
      if ('merge' in write.options) return sdk.setDoc(ref, data, { merge: true });
      return sdk.setDoc(ref, data, { mergeFields: [...write.options.mergeFields] });
    }
  }
}
