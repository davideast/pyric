/**
 * The `firestore` tool: the modular Firestore SDK's method and argument names,
 * with paths standing in for the `DocumentReference` and `CollectionReference`
 * a real call would carry.
 *
 * Segment parity is the rule this file spends most of its checking on, because
 * it is the one an agent gets wrong silently: `setDoc` on `users` and `addDoc`
 * on `users/alice` are both well formed JSON and both wrong, and the SDK would
 * have refused them at the reference constructor rather than at the write.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments, MethodSpec, ToolSpec } from './shared.js';
import { quoted } from './shared.js';

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

const constraint = z
  .object({
    type: z.string().describe('where, orderBy, or limit.'),
    field: z.string().optional().describe('Field for where and orderBy.'),
    op: z.string().optional().describe('Comparison operator for where.'),
    value: z.unknown().describe('Comparison value for where, or the count for limit.'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction for orderBy.'),
  })
  .describe('One query constraint, spelled as the SDK names it.');

const writeEntry = z
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

const RENAMES: Readonly<Record<string, string>> = {
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
function checkDocumentPath(method: string, args: Args, fail: Fail): InvalidArguments | null {
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
function checkCollectionPath(method: string, args: Args, fail: Fail): InvalidArguments | null {
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
function constraintsOf(args: Args): Args[] {
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
    `Order by '${field}' first, then by '${ordered}'.`,
    'constraints',
  );
}

function checkConstraints(args: Args, fail: Fail): InvalidArguments | null {
  const collection = checkCollectionPath('getDocs', args, fail);
  if (collection !== null) return collection;
  const entries = constraintsOf(args);
  for (const [index, entry] of entries.entries()) {
    const issue = checkOneConstraint(index, entry, fail);
    if (issue !== null) return issue;
  }
  return checkInequalityOrdering(entries, fail);
}

/** The canonical query arguments a constraint list builds. */
function queryArguments(args: Args): Args {
  const entries = constraintsOf(args);
  const filters = entries
    .filter((entry) => entry.type === 'where')
    .map((entry) => ({ field: entry.field, op: entry.op, value: entry.value }));
  const order = entries.find((entry) => entry.type === 'orderBy');
  const limit = entries.find((entry) => entry.type === 'limit');
  const call: Args = { path: args.path };
  if (filters.length > 0) call.filters = filters;
  if (order !== undefined) {
    call.orderBy = order.field;
    if (order.direction !== undefined) call.direction = order.direction;
  }
  if (limit !== undefined) call.limit = limit.value;
  return call;
}

function checkBatch(args: Args, fail: Fail): InvalidArguments | null {
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

const METHODS: readonly MethodSpec[] = [
  {
    name: 'getDoc',
    signature: 'getDoc(path)',
    summary: 'Read one document.',
    args: z.object({ path: z.string().describe('Document path, for example users/alice.') }),
    operations: ['get_firestore_document'],
    renames: RENAMES,
    example: { path: 'users/alice' },
    resolve: () => 'get_firestore_document',
    translate: (args) => ({ path: args.path }),
    check: (args, fail) => checkDocumentPath('getDoc', args, fail),
  },
  {
    name: 'getDocs',
    signature: 'getDocs(path, constraints?)',
    summary:
      'Read a collection. With no constraints this lists the collection; with constraints it runs a query.',
    args: z.object({
      path: z.string().describe('Collection path, for example users.'),
      constraints: z
        .array(constraint)
        .optional()
        .describe('where, orderBy, and limit constraints, applied in order.'),
    }),
    operations: ['list_firestore_documents', 'query_firestore_documents'],
    renames: RENAMES,
    example: {
      path: 'users',
      constraints: [
        { type: 'where', field: 'role', op: '==', value: 'admin' },
        { type: 'limit', value: 10 },
      ],
    },
    resolve: (args) =>
      constraintsOf(args).length === 0 ? 'list_firestore_documents' : 'query_firestore_documents',
    translate: (args) =>
      constraintsOf(args).length === 0 ? { path: args.path } : queryArguments(args),
    check: checkConstraints,
  },
  {
    name: 'setDoc',
    signature: 'setDoc(path, data, options?)',
    summary: 'Write one document, replacing it unless options.merge is true.',
    args: z.object({
      path: z.string().describe('Document path, for example users/alice.'),
      data: z.record(z.unknown()).describe('The document fields to write.'),
      options: z
        .object({
          merge: z
            .boolean()
            .optional()
            .describe('Merge the fields into the existing document instead of replacing it.'),
        })
        .optional()
        .describe('Set options.'),
    }),
    operations: ['write_firestore_document'],
    renames: RENAMES,
    example: { path: 'users/alice', data: { role: 'admin' }, options: { merge: true } },
    resolve: () => 'write_firestore_document',
    translate: (args) => {
      const options = (args.options ?? {}) as Args;
      const call: Args = { path: args.path, data: args.data };
      if (options.merge === true) call.merge = true;
      return call;
    },
    check: (args, fail) => checkDocumentPath('setDoc', args, fail),
  },
  {
    name: 'addDoc',
    signature: 'addDoc(path, data)',
    summary: 'Add a document to a collection under a generated id.',
    args: z.object({
      path: z.string().describe('Collection path, for example users.'),
      data: z.record(z.unknown()).describe('The document fields to write.'),
    }),
    operations: ['add_firestore_document'],
    renames: RENAMES,
    example: { path: 'users', data: { email: 'alice@example.com' } },
    resolve: () => 'add_firestore_document',
    translate: (args) => ({ path: args.path, data: args.data }),
    check: (args, fail) => checkCollectionPath('addDoc', args, fail),
  },
  {
    name: 'updateDoc',
    signature: 'updateDoc(path, data)',
    summary: 'Merge fields into an existing document.',
    args: z.object({
      path: z.string().describe('Document path, for example users/alice.'),
      data: z.record(z.unknown()).describe('The fields to merge.'),
    }),
    operations: ['update_firestore_document'],
    renames: RENAMES,
    example: { path: 'users/alice', data: { role: 'editor' } },
    resolve: () => 'update_firestore_document',
    translate: (args) => ({ path: args.path, data: args.data }),
    check: (args, fail) => checkDocumentPath('updateDoc', args, fail),
  },
  {
    name: 'deleteDoc',
    signature: 'deleteDoc(path)',
    summary: 'Delete one document.',
    args: z.object({ path: z.string().describe('Document path, for example users/alice.') }),
    operations: ['delete_firestore_document'],
    renames: RENAMES,
    example: { path: 'users/alice' },
    resolve: () => 'delete_firestore_document',
    translate: (args) => ({ path: args.path }),
    check: (args, fail) => checkDocumentPath('deleteDoc', args, fail),
  },
  {
    name: 'writeBatch',
    signature: 'writeBatch(writes)',
    summary: 'Apply several writes in order, stopping at the first failure.',
    args: z.object({
      writes: z.array(writeEntry).describe('The writes, applied in order.'),
    }),
    operations: ['batch_firestore_writes'],
    renames: RENAMES,
    example: {
      writes: [
        { type: 'set', path: 'users/alice', data: { role: 'admin' } },
        { type: 'delete', path: 'users/bob' },
      ],
    },
    resolve: () => 'batch_firestore_writes',
    translate: (args) => ({
      writes: (args.writes as Args[]).map((write) => {
        const options = (write.options ?? {}) as Args;
        const merged = write.type === 'set' && options.merge === true;
        const entry: Args = { op: merged ? 'update' : write.type, path: write.path };
        if (write.data !== undefined) entry.data = write.data;
        return entry;
      }),
    }),
    check: checkBatch,
  },
];

export const FIRESTORE_TOOL: ToolSpec = {
  name: 'firestore',
  intro:
    'Cloud Firestore in the sandbox, called with the modular SDK method names and argument names. A reference is a path string: a document path has an even number of segments and a collection path an odd number.',
  methods: METHODS,
};
