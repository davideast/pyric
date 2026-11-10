/**
 * Payload shapes: which fields a write sets, what kind of value each one
 * is, and which come from the signed-in user.
 */
import { mergeAuth } from './paths.js';
import type { AuthProvenance, PayloadField, PayloadShape } from './types.js';
import { alternatives, authMarksOf, literalText, renderParts, union, type AVal } from './values.js';

type Kind = PayloadField['kind'];
type SentinelKind = Extract<Kind, 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'deleteField'>;

const SENTINEL_KINDS = new Set<string>(['serverTimestamp', 'increment', 'arrayUnion', 'arrayRemove', 'deleteField']);

function isSentinelKind(value: string): value is SentinelKind {
  return SENTINEL_KINDS.has(value);
}

export function sentinelObjKind(a: Extract<AVal, { k: 'obj' }>, force?: (v: AVal) => AVal): SentinelKind | undefined {
  if (a.props.has('_brand') && a.props.has('type')) {
    const typeVal = a.props.get('type')!;
    const resolved = force ? force(typeVal) : typeVal;
    const text = literalText(resolved);
    if (text !== null && isSentinelKind(text)) {
      return text;
    }
  }
  return undefined;
}

/** Coarse kind of a value; a union of one kind (plus null/undefined) keeps that kind. */
export function kindOf(v: AVal, force?: (v: AVal) => AVal): Kind {
  const kinds = new Set<Kind>();
  for (const a of alternatives(v)) {
    const k = leafKind(a, force);
    if (k !== undefined) kinds.add(k);
  }
  if (kinds.size > 1) kinds.delete('null');
  if (kinds.size > 1 && kinds.has('deleteField')) kinds.delete('deleteField');
  if (kinds.size === 1) return [...kinds][0];
  return 'unknown';
}

function leafKind(a: AVal, force?: (v: AVal) => AVal): Kind | undefined {
  switch (a.k) {
    case 'str':
      return 'string';
    case 'num':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'null':
      return 'null';
    case 'undefined':
      return undefined;
    case 'obj': {
      const sentinel = sentinelObjKind(a, force);
      if (sentinel) return sentinel;
      return 'object';
    }
    case 'arr':
      return 'array';
    case 'fieldValue':
      return a.name;
    default:
      return 'unknown';
  }
}

/** Auth provenance of a value, or undefined when none. */
export function authOf(v: AVal): AuthProvenance[] | undefined {
  const marks = authMarksOf(v);
  if (marks.length === 0) return undefined;
  return mergeAuth(marks, true);
}

function literalOf(v: AVal): string | number | boolean | null | undefined {
  if (v.k === 'null') return null;
  if (v.k === 'num' && v.value !== undefined) return v.value;
  if (v.k === 'bool' && v.value !== undefined) return v.value;
  const text = literalText(v);
  if (text !== null && text.length <= 80) return text;
  return undefined;
}

function isGuaranteedNonNullRtdbValue(
  value: AVal,
  force: ((v: AVal) => AVal) | undefined,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  const resolved = force ? force(value) : value;
  const alts = alternatives(resolved);
  if (alts.length === 0) return false;
  return alts.every((alt) => {
    if (alt.k === 'str' || alt.k === 'num' || alt.k === 'bool') return true;
    if (alt.k === 'fieldValue') {
      return alt.name === 'serverTimestamp' || alt.name === 'increment';
    }
    if (alt.k === 'obj') {
      const sentinel = sentinelObjKind(alt, force);
      if (sentinel === 'serverTimestamp' || sentinel === 'increment') return true;
      if (sentinel !== undefined) return false;
      for (const [k, childVal] of alt.props) {
        if (!alt.optional.has(k) && isGuaranteedNonNullRtdbValue(childVal, force, depth + 1)) {
          return true;
        }
      }
      return false;
    }
    if (alt.k === 'arr') {
      if (alt.open || alt.items.length === 0) return false;
      return alt.items.some((item) => isGuaranteedNonNullRtdbValue(item, force, depth + 1));
    }
    return false;
  });
}

function isGuaranteedNonNullArray(value: AVal, force?: (v: AVal) => AVal): boolean {
  const resolved = force ? force(value) : value;
  const alts = alternatives(resolved);
  if (alts.length === 0) return false;
  return alts.every(
    (alt) =>
      alt.k === 'arr'
      && !alt.open
      && alt.items.length > 0
      && alt.items.some((item) => isGuaranteedNonNullRtdbValue(item, force, 1)),
  );
}

function field(name: string, value: AVal, optional: boolean, force?: (v: AVal) => AVal): PayloadField {
  const f: PayloadField = { name, kind: kindOf(value, force) };
  const auth = authOf(value);
  if (auth) f.auth = auth;
  if (optional) f.optional = true;
  if (f.kind === 'array' && isGuaranteedNonNullArray(value, force)) f.nonEmpty = true;
  const literal = literalOf(value);
  if (literal !== undefined) f.literal = literal;
  return f;
}

/** Deepest nested level whose fields are listed (`speaker/uid` is level 2). */
const MAX_FIELD_DEPTH = 3;

interface FieldEntry {
  values: AVal[];
  optional: boolean;
  seen: number;
}

function collectObjectEntries(
  objects: Extract<AVal, { k: 'obj' }>[],
  force: (v: AVal) => AVal,
  allowMultiPathKey: boolean,
): { byName: Map<string, FieldEntry>; open: boolean } {
  const byName = new Map<string, FieldEntry>();
  let open = false;
  for (const o of objects) {
    if (o.open) open = true;
    for (const [name, val] of o.props) {
      const entry = byName.get(name) ?? { values: [], optional: false, seen: 0 };
      entry.values.push(force(val));
      entry.seen += 1;
      if (o.optional.has(name)) entry.optional = true;
      byName.set(name, entry);
    }
    for (const c of o.computed) {
      const key = force(c.key);
      let name = literalText(key);
      if (name === null && allowMultiPathKey && key.k === 'str') {
        const rendered = renderParts(key.parts);
        if (rendered.includes('/')) name = rendered;
      }
      if (name === null) {
        open = true;
        continue;
      }
      const entry = byName.get(name) ?? { values: [], optional: false, seen: 0 };
      entry.values.push(force(c.value));
      entry.seen += 1;
      byName.set(name, entry);
    }
  }
  return { byName, open };
}

/**
 * Shape of a written value. `force` resolves deferred values. Fields of
 * nested objects are listed too, joined with `separator` (`/` for RTDB,
 * `.` for Firestore), so `{ speaker: { uid } }` yields `speaker/uid`.
 */
export function payloadShape(value: AVal, force: (v: AVal) => AVal, separator = '/'): PayloadShape {
  const v = force(value);
  const alts = alternatives(v);
  const objects = alts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj' && !sentinelObjKind(a, force));
  if (objects.length === 0) {
    const shape: PayloadShape = { kind: kindOf(v), fields: [], open: v.k === 'unknown' };
    if (shape.kind === 'array' && isGuaranteedNonNullArray(v, force)) shape.nonEmpty = true;
    const auth = authOf(v);
    if (auth) shape.auth = auth;
    const literal = literalOf(v);
    if (literal !== undefined) shape.literal = literal;
    return shape;
  }
  const collected = collectObjectEntries(objects, force, separator === '/');
  let open = collected.open || alts.some((a) => a.k === 'unknown');
  const fields: PayloadField[] = [];
  for (const [name, entry] of collected.byName) {
    const merged = union(entry.values);
    const optional = entry.optional || entry.seen < objects.length;
    fields.push(field(name, merged, optional, force));
    if (nestedFields(name, merged, optional, force, separator, 2, fields)) {
      open = true;
    }
  }
  return { kind: 'object', fields, open };
}

/** Append the fields of an object-valued field, recursively, as `parent<sep>child`. Returns true if any nested object is open. */
function nestedFields(
  prefix: string,
  value: AVal,
  optional: boolean,
  force: (v: AVal) => AVal,
  separator: string,
  depth: number,
  out: PayloadField[],
): boolean {
  const alts = alternatives(force(value));
  const objects = alts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj' && !sentinelObjKind(a, force));
  if (objects.length === 0) return false;
  if (depth > MAX_FIELD_DEPTH) {
    return objects.some((o) => o.open || o.computed.length > 0);
  }
  const collected = collectObjectEntries(objects, force, false);
  let open = collected.open || alts.some((a) => a.k === 'unknown');
  for (const [name, entry] of collected.byName) {
    const merged = union(entry.values);
    const full = `${prefix}${separator}${name}`;
    const childOptional = optional || entry.optional || entry.seen < objects.length;
    out.push(field(full, merged, childOptional, force));
    if (nestedFields(full, merged, childOptional, force, separator, depth + 1, out)) {
      open = true;
    }
  }
  return open;
}
