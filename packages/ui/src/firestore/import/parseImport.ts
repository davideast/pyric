/**
 * JSON import parsing + collision detection for the Firestore "import JSON
 * into a collection" flow.
 *
 * Pure, no React, no I/O: `parseImport` takes the raw pasted/loaded text and
 * returns the documents it would create plus any per-item errors; the caller
 * (the Studio pane) owns showing the "will create N documents" preview,
 * disclosing a collision policy ONLY when {@link detectCollisions} finds an
 * overlap, and actually writing through the existing Firestore write handle.
 *
 * Two accepted shapes:
 *   1. A map:   `{ "docId": { ...fields }, "docId2": { ...fields } }`
 *      — each key becomes the document id (validated), each value its data.
 *   2. An array: `[ { ...fields }, { ...fields } ]`
 *      — each element becomes a document with `id: null` (auto-id at write
 *      time), since a bare array carries no natural id.
 */

import { validateDocumentId } from '../validation/ids.js';

/** One document to create. `id === null` means "let Firestore auto-id it"
 *  (only produced by the array shape — a map key is always a chosen id). */
export interface ParsedImportDoc {
  id: string | null;
  data: Record<string, unknown>;
}

export interface ParseImportResult {
  docs: ParsedImportDoc[];
  /** Human-readable problems found while parsing. A non-empty `errors` does
   *  NOT necessarily mean `docs` is empty — the parser is per-item tolerant
   *  so one bad entry doesn't block the rest; the caller decides whether to
   *  block on any error or proceed with the valid subset. */
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse raw JSON text into the documents it would create. Never throws —
 * a JSON syntax error or a wrong top-level shape becomes an entry in
 * `errors` with an empty `docs` array.
 */
export function parseImport(input: string): ParseImportResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { docs: [], errors: ['Input is empty'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { docs: [], errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const docs: ParsedImportDoc[] = [];
  const errors: string[] = [];

  if (Array.isArray(parsed)) {
    parsed.forEach((item, i) => {
      if (!isPlainObject(item)) {
        errors.push(`Item ${i}: expected an object, got ${describeType(item)}`);
        return;
      }
      docs.push({ id: null, data: item });
    });
    return { docs, errors };
  }

  if (isPlainObject(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      const idError = validateDocumentId(key);
      if (idError) {
        errors.push(`"${key}": invalid document id — ${idError}`);
        continue;
      }
      if (!isPlainObject(value)) {
        errors.push(`"${key}": expected an object of fields, got ${describeType(value)}`);
        continue;
      }
      docs.push({ id: key, data: value });
    }
    return { docs, errors };
  }

  return {
    docs: [],
    errors: ['Input must be a JSON object mapping docId -> fields, or an array of objects'],
  };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Ids in `docs` (map-shape entries only — `id !== null`) that already exist
 * in `existingIds`. The UI shows the skip-or-overwrite policy choice ONLY
 * when this returns a non-empty list.
 */
export function detectCollisions(
  existingIds: readonly string[],
  docs: readonly ParsedImportDoc[],
): string[] {
  const existing = new Set(existingIds);
  const collisions: string[] = [];
  for (const doc of docs) {
    if (doc.id !== null && existing.has(doc.id)) collisions.push(doc.id);
  }
  return collisions;
}
