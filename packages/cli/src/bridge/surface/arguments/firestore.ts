/**
 * The `firestore` tool's argument vocabulary: the schema fragments its methods
 * share, the names a neighbouring API spells differently, and the rules a
 * schema cannot state.
 *
 * Segment parity is the rule this file spends most of its checking on, because
 * it is the one an agent gets wrong silently: `setDoc` on `users` and `addDoc`
 * on `users/alice` are both well formed JSON and both wrong, and the SDK would
 * have refused them at the reference constructor rather than at the write.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { quoted } from '../closest-name.js';
import { decodeFieldValues, type FieldValueScope } from './field-values.js';

/** The where operators the SDK accepts. */
const OPERATORS = [
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'in',
  'not-in',
  'array-contains',
  'array-contains-any',
] as const;

/** The operators Firestore treats as a range, which constrain the first ordering. */
const INEQUALITIES = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);

const CONSTRAINT_TYPES = ['where', 'orderBy', 'limit'];

/** One query constraint, spelled as the SDK names it. */
export const constraint = z
  .object({
    type: z.string().describe('where, orderBy, or limit.'),
    field: z.string().optional().describe('Field for where and orderBy.'),
    op: z.string().optional().describe('Comparison operator for where.'),
    value: z.unknown().describe('Comparison value for where, or the count for limit.'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction for orderBy.'),
  })
  .describe('One query constraint, spelled as the SDK names it.');

/** One batched write. */
export const writeEntry = z
  .object({
    type: z.enum(['set', 'update', 'delete']).describe('The write this entry performs.'),
    path: z.string().describe('Document path the write targets.'),
    data: z.record(z.unknown()).optional().describe('Fields for set and update.'),
    options: z
      .object({ merge: z.boolean().optional().describe('Merge rather than replace.') })
      .optional()
      .describe('Set options.'),
  })
  .describe('One batched write.');

export const RENAMES: Readonly<Record<string, string>> = {
  collection: 'path',
  collectionPath: 'path',
  documentPath: 'path',
  docPath: 'path',
  ref: 'path',
  reference: 'path',
  doc: 'path',
  fields: 'data',
  filters: 'constraints',
  where: 'constraints',
  merge: 'options',
};

/** The segments of a path, with the empties a stray slash leaves dropped. */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** A document path names a document, so it has an even number of segments. */
export function checkDocumentPath(
  method: string,
  args: Args,
  fail: Fail,
): InvalidArguments | null {
  const path = String(args.path);
  const parts = segments(path);
  if (parts.length > 0 && parts.length % 2 === 0) return null;
  const noun = parts.length === 0 ? 'an empty path' : 'a collection path, not a document path';
  return fail(
    `${quoted(path)} is ${noun}. A document path has an even number of segments, so ${method} needs a document id after the collection.`,
    `Pass path as '${path === '' ? 'users' : path}/<documentId>'.`,
    'path',
  );
}

/** A collection path names a collection, so it has an odd number of segments. */
export function checkCollectionPath(
  method: string,
  args: Args,
  fail: Fail,
): InvalidArguments | null {
  const path = String(args.path);
  const parts = segments(path);
  if (parts.length > 0 && parts.length % 2 === 1) return null;
  if (parts.length === 0) {
    return fail(
      `${quoted(path)} is an empty path. A collection path has an odd number of segments.`,
      `Pass path as a collection such as 'users'.`,
      'path',
    );
  }
  return fail(
    `${quoted(path)} is a document path, not a collection path. A collection path has an odd number of segments, so ${method} takes the collection without the document id.`,
    `Pass path as '${parts.slice(0, -1).join('/')}'.`,
    'path',
  );
}

/** Read the constraints argument as a list, empty when it is absent. */
export function constraintsOf(args: Args): Args[] {
  const raw = args.constraints;
  return Array.isArray(raw) ? (raw as Args[]) : [];
}

function checkOneConstraint(index: number, entry: Args, fail: Fail): InvalidArguments | null {
  const at = `constraint ${index}`;
  const type = entry.type;
  if (typeof type !== 'string' || !CONSTRAINT_TYPES.includes(type)) {
    return fail(
      `${at} has type ${quoted(type)}. getDocs constraints are where, orderBy, and limit.`,
      `Set the type of ${at} to one of where, orderBy, limit.`,
      `constraints.${index}.type`,
    );
  }
  if (type === 'where') {
    if (typeof entry.field !== 'string') {
      return fail(
        `${at} is a where with field ${quoted(entry.field)}. The SDK signature is where(field, op, value).`,
        `Give ${at} a field name.`,
        `constraints.${index}.field`,
      );
    }
    if (typeof entry.op !== 'string' || !OPERATORS.includes(entry.op as never)) {
      return fail(
        `${at} uses operator ${quoted(entry.op)}. The SDK operators are ${OPERATORS.join(', ')}.`,
        `Use '==' for an equality filter, or another operator from that list.`,
        `constraints.${index}.op`,
      );
    }
  }
  if (type === 'orderBy' && typeof entry.field !== 'string') {
    return fail(
      `${at} is an orderBy with field ${quoted(entry.field)}. The SDK signature is orderBy(field, direction?).`,
      `Give ${at} a field name.`,
      `constraints.${index}.field`,
    );
  }
  if (type === 'limit' && typeof entry.value !== 'number') {
    return fail(
      `${at} is a limit with value ${quoted(entry.value)}. The SDK signature is limit(count).`,
      `Set the value of ${at} to a number.`,
      `constraints.${index}.value`,
    );
  }
  return null;
}

/**
 * Firestore orders by the inequality field first, so a query that filters on a
 * range and then orders on something else is refused by the backend rather than
 * silently reordered.
 */
function checkInequalityOrdering(entries: Args[], fail: Fail): InvalidArguments | null {
  const inequality = entries.find(
    (entry) => entry.type === 'where' && INEQUALITIES.has(String(entry.op)),
  );
  const firstOrder = entries.find((entry) => entry.type === 'orderBy');
  if (inequality === undefined || firstOrder === undefined) return null;
  const field = String(inequality.field);
  const ordered = String(firstOrder.field);
  if (field === ordered) return null;
  return fail(
    `an inequality filter on '${field}' with the first orderBy on '${ordered}'. Firestore requires the first orderBy field to match the inequality field.`,
    `Pass orderBy '${field}' first, then '${ordered}'.`,
    'constraints',
  );
}

/** Check a collection read: its path, each constraint, and their ordering. */
export function checkConstraints(args: Args, fail: Fail): InvalidArguments | null {
  const collection = checkCollectionPath('getDocs', args, fail);
  if (collection !== null) return collection;
  const entries = constraintsOf(args);
  for (const [index, entry] of entries.entries()) {
    const issue = checkOneConstraint(index, entry, fail);
    if (issue !== null) return issue;
  }
  return checkInequalityOrdering(entries, fail);
}

/** A constraint list, read as the parts the data plane takes separately. */
export interface CollectionRead {
  /** The sandbox tool call: the collection, and the where, ordering, and limit it carries. */
  call: Args;
  /** Whether any where clause is present, which is what makes the read a query. */
  filtered: boolean;
  /** The sort direction, applied to the result rather than to the call. */
  direction: string | undefined;
}

/** The data-plane call one collection path and constraint list build. */
export function collectionRead(args: Args): CollectionRead {
  const entries = constraintsOf(args);
  const filters = entries
    .filter((entry) => entry.type === 'where')
    .map((entry) => ({ field: entry.field, op: entry.op, value: entry.value }));
  const order = entries.find((entry) => entry.type === 'orderBy');
  const limit = entries.find((entry) => entry.type === 'limit');
  const call: Args = { collection: args.path };
  if (order !== undefined) call.orderBy = order.field;
  if (limit !== undefined) call.limit = limit.value;
  if (filters.length > 0) call.where = filters;
  const direction = order === undefined ? undefined : (order.direction as string | undefined);
  return { call, filtered: filters.length > 0, direction };
}

/** Every batched write names one document and carries the fields it writes. */
export function checkBatch(args: Args, fail: Fail): InvalidArguments | null {
  const writes = args.writes as Args[];
  for (const [index, write] of writes.entries()) {
    const parts = segments(String(write.path));
    if (parts.length === 0 || parts.length % 2 === 1) {
      return fail(
        `write ${index} targets ${quoted(write.path)}, which is not a document path. Every batched write names one document, so its path has an even number of segments.`,
        `Pass write ${index} a path such as '${String(write.path)}/<documentId>'.`,
        `writes.${index}.path`,
      );
    }
    if (write.type !== 'delete' && write.data === undefined) {
      return fail(
        `write ${index} is a ${String(write.type)} with no data. set and update carry the fields they write.`,
        `Give write ${index} a data object.`,
        `writes.${index}.data`,
      );
    }
  }
  return null;
}

// ─── Field values ─────────────────────────────────────────────────────────
//
// `data` used to travel verbatim, so an agent could write any value except the
// five that are function calls in the SDK. `field-values.ts` owns the JSON
// spelling of those five; these two functions are how the write methods reach
// it, once to refuse a bad spelling before the call runs and once to decode a
// good one on the way through.

/** Where `$deleteField` is accepted: an update, and nothing else. */
function acceptsDeleteField(method: string): boolean {
  return method === 'updateDoc';
}

/** The scope one direct write decodes under. */
function scopeFor(method: string): FieldValueScope {
  return { method, deleteFieldAccepted: acceptsDeleteField(method), root: 'data' };
}

/** Refuse a field-value spelling `data` gets wrong, naming the field path. */
export function checkFieldValues(
  method: string,
  args: Args,
  fail: Fail,
): InvalidArguments | null {
  const decoded = decodeFieldValues(args.data, scopeFor(method));
  if (decoded.ok) return null;
  return fail(decoded.body, decoded.fix, decoded.path);
}

/**
 * `data` with every field-value spelling replaced by the SDK's own value.
 * Called after {@link checkFieldValues} has passed, so a refusal here cannot
 * happen; if one somehow did, the data is passed through unchanged and the
 * write plane refuses it rather than this returning a half-decoded object.
 */
export function fieldValuesOf(method: string, data: unknown): unknown {
  const decoded = decodeFieldValues(data, scopeFor(method));
  if (decoded.ok) return decoded.value;
  return data;
}

/** The scope one batched write decodes under, named by its index. */
function batchScopeFor(index: number, type: unknown): FieldValueScope {
  return {
    method: `a writeBatch ${String(type)}`,
    deleteFieldAccepted: type === 'update',
    root: `writes.${index}.data`,
  };
}

/** Refuse a field-value spelling any batched write gets wrong. */
export function checkBatchFieldValues(args: Args, fail: Fail): InvalidArguments | null {
  for (const [index, write] of (args.writes as Args[]).entries()) {
    const decoded = decodeFieldValues(write.data, batchScopeFor(index, write.type));
    if (!decoded.ok) return fail(decoded.body, decoded.fix, decoded.path);
  }
  return null;
}

/** One batched write's `data`, with its field-value spellings decoded. */
export function batchFieldValuesOf(index: number, write: Args): unknown {
  const decoded = decodeFieldValues(write.data, batchScopeFor(index, write.type));
  if (decoded.ok) return decoded.value;
  return write.data;
}
