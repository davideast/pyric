/**
 * Write composite index definitions to `firestore.indexes.json`, overwriting
 * whatever the project already has there.
 *
 * The design's `extractIndexes` table entry marks it "destructive with
 * write", but the effect model (`method-effects.ts`) is static per record: one
 * record cannot be `read` for a bare call and `destructive` for a `write:
 * true` call. This is the split that reconciles the two: `extractIndexes`
 * stays a plain `read`, and this record carries the destructive half, taking
 * the definitions to write rather than recomputing them, so the caller can
 * inspect what `extractIndexes` found before deciding to write it.
 */
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

const DEFAULT_INDEXES_PATH = 'firestore.indexes.json';

// `order` and `queryScope` are Firestore's own enums (ASCENDING/DESCENDING,
// COLLECTION/COLLECTION_GROUP), but they arrive here as `extractIndexes`'s own
// output rather than as a value this record's caller chooses among, so they
// stay plain strings: nothing here rejects one of them by name, and the
// enum-in-signature invariant applies to a closed set a caller picks, not to a
// shape passed straight through from one record to another.
const indexField = z.object({
  fieldPath: z.string(),
  order: z.string().optional().describe('ASCENDING or DESCENDING.'),
  arrayConfig: z.literal('CONTAINS').optional(),
});

const indexEntry = z.object({
  collectionGroup: z.string(),
  queryScope: z.string().describe('COLLECTION or COLLECTION_GROUP.'),
  fields: z.array(indexField),
});

interface IndexesFile {
  indexes: Array<z.infer<typeof indexEntry>>;
  fieldOverrides?: unknown[];
}

/** The stable key one index entry sorts and compares by. */
function keyOf(entry: z.infer<typeof indexEntry>): string {
  const fields = entry.fields.map((field) => `${field.fieldPath}:${field.order ?? 'ASCENDING'}`);
  return `${entry.queryScope}|${entry.collectionGroup}|${fields.join(',')}`;
}

/** What changed between the file that was there and the one just written. */
function diff(before: IndexesFile | null, after: IndexesFile): { added: string[]; removed: string[] } {
  const beforeKeys = new Set((before?.indexes ?? []).map(keyOf));
  const afterKeys = new Set(after.indexes.map(keyOf));
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key));
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key));
  return { added, removed };
}

/** The file at `path`, or null when it does not exist or does not parse. */
function readExisting(path: string): IndexesFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as IndexesFile;
  } catch {
    return null;
  }
}

export default {
  tool: 'firestore',
  method: 'writeIndexes',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'writeIndexes(indexes, path?, confirm)',
  description: 'Write index definitions, overwriting firestore.indexes.json.',
  args: z.object({
    indexes: z.array(indexEntry).describe('The index definitions extractIndexes found.'),
    path: z
      .string()
      .optional()
      .describe(`Where to write, inside the project directory. Default '${DEFAULT_INDEXES_PATH}'.`),
    confirm: z.boolean().optional().describe('Must be true. Overwrites the existing file.'),
  }),
  operation: 'write_firestore_indexes',
  example: {
    indexes: [
      {
        collectionGroup: 'orders',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'createdAt', order: 'DESCENDING' },
        ],
      },
    ],
    confirm: true,
  },
  async handler(args, ctx) {
    const given = typeof args.path === 'string' ? args.path : DEFAULT_INDEXES_PATH;
    const resolved = projectPathWithin(ctx.projectDir, given, 'path', failFor('firestore', 'writeIndexes'));
    if (!('path' in resolved)) return resolved;
    const indexes = args.indexes as Array<z.infer<typeof indexEntry>>;
    const file: IndexesFile = { indexes, fieldOverrides: [] };
    const before = readExisting(resolved.path);
    writeFileSync(resolved.path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    const changed = diff(before, file);
    const parts: string[] = [`wrote ${indexes.length} index(es) to ${given}`];
    if (changed.added.length > 0) parts.push(`${changed.added.length} added`);
    if (changed.removed.length > 0) parts.push(`${changed.removed.length} removed`);
    return {
      ok: true,
      summary: `${parts.join(', ')}.`,
      data: { path: given, count: indexes.length, added: changed.added.length, removed: changed.removed.length },
    };
  },
} satisfies MethodRecord;
