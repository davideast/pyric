/**
 * Seed-apply logic for the host **data-seed panel** (SF-S2) — the
 * human-driven analog of the agent's `seed_firestore_data_as_admin`
 * tool. The user picks a collection and supplies documents (as a small
 * form or a JSON blob); this module parses + applies them through the
 * runner's admin surface so they persist per session and bypass rules,
 * exactly like the agent's seed tool and the Firestore tab's edits.
 *
 * Why a standalone module (not inline in the panel): the parse + apply
 * is the testable core of the affordance — `applySeed(admin, …)` writes
 * docs, `clearCollection(admin, …)` removes them, both against an
 * injected admin surface. The panel is a thin shell over this; the
 * gate's "apply docs → sandbox has them → switch session → gone" check
 * drives this module headlessly (no DOM), mirroring the seed-tool +
 * runner-persistence test idioms.
 *
 * Boundaries (binding — app-spec section 3.6): this writes ONLY to the current
 * session's sandbox via the same admin/persistence path P3 established.
 * It is session runtime state — never a workspace file, never a spec
 * field, never generated app code. The user populates the sandbox the
 * way the Auth tab populates identities.
 */

/**
 * The slice of `Sandbox['admin']` this module needs. Accepting the
 * narrow surface (rather than a whole runner) keeps the logic unit-
 * testable against a fake and makes the dependency explicit: callers
 * pass the active playground runtime — shared sessions write through
 * the SharedWorker, isolated sessions write through the runner's admin
 * wrapper.
 */
export interface AdminSeedSurface {
  setDocument(path: string, data: Record<string, unknown>): void;
  deleteDocument(path: string): { deleted: boolean } | void;
  listDocuments(prefix: string): { path: string; data: unknown; phantom?: true }[];
}

export interface AsyncAdminSeedSurface {
  setDocument(path: string, data: Record<string, unknown>): Promise<void>;
  deleteDocument(path: string): Promise<unknown>;
  listDocuments(prefix: string): Promise<{ path: string; data: unknown; phantom?: true }[]>;
}

/** One document to seed: an id (auto-generated if blank) + its body. */
export interface SeedDoc {
  /** Document id within the collection. Empty → auto-generated. */
  id: string;
  data: Record<string, unknown>;
}

export interface ApplyResult {
  applied: number;
  failed: number;
  errors: { id: string; error: string }[];
}

/** Firestore collection-id sanity: no slashes (a single segment). */
export function isValidCollectionId(id: string): boolean {
  const t = id.trim();
  return t.length > 0 && !t.includes('/') && t !== '.' && t !== '..';
}

/** Firestore doc-id sanity: non-empty single segment, no slashes. */
export function isValidDocId(id: string): boolean {
  return id.length > 0 && !id.includes('/') && id !== '.' && id !== '..';
}

/**
 * Auto-id generator for docs added without an explicit id. Not
 * Firestore's exact 20-char base62 scheme — just a collision-resistant
 * id good enough for human-seeded demo data (timestamp + random).
 */
export function generateDocId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `seed_${Date.now().toString(36)}${rand}`;
}

/**
 * Parse a JSON blob into a list of seed docs. Two accepted shapes,
 * both mapping naturally to "documents in a collection":
 *
 *   - an OBJECT keyed by doc id → `{ "doc1": {…}, "doc2": {…} }`
 *     (ids are the keys; the cleanest shape for fixed-id fixtures);
 *   - an ARRAY of doc bodies → `[ {…}, {…} ]` (ids auto-generated,
 *     unless an entry carries an `id` / `_id` string field, which is
 *     lifted out and used as the doc id).
 *
 * Each value/entry must be a JSON object (a Firestore document body).
 * Returns a discriminated result so the panel can show a parse error
 * inline rather than throwing.
 */
export type ParseResult =
  | { ok: true; docs: SeedDoc[] }
  | { ok: false; error: string };

export function parseSeedJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Enter one or more documents as JSON.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (Array.isArray(parsed)) {
    const docs: SeedDoc[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (!isPlainObject(entry)) {
        return { ok: false, error: `Entry [${i}] must be a JSON object (a document body).` };
      }
      const { id, body } = liftId(entry);
      if (id !== null && !isValidDocId(id)) {
        return { ok: false, error: `Entry [${i}] has an invalid id "${id}" (no slashes).` };
      }
      docs.push({ id: id ?? '', data: body });
    }
    return { ok: true, docs };
  }

  if (isPlainObject(parsed)) {
    const docs: SeedDoc[] = [];
    for (const [id, body] of Object.entries(parsed)) {
      if (!isValidDocId(id)) {
        return { ok: false, error: `Key "${id}" is not a valid document id (no slashes).` };
      }
      if (!isPlainObject(body)) {
        return { ok: false, error: `Document "${id}" must be a JSON object.` };
      }
      docs.push({ id, data: body });
    }
    if (docs.length === 0) {
      return { ok: false, error: 'No documents found in the object.' };
    }
    return { ok: true, docs };
  }

  return {
    ok: false,
    error: 'Top-level JSON must be an object (keyed by id) or an array of documents.',
  };
}

/** Lift an `id` / `_id` string field out of a doc body, if present. */
function liftId(entry: Record<string, unknown>): {
  id: string | null;
  body: Record<string, unknown>;
} {
  const raw = entry.id ?? entry._id;
  if (typeof raw === 'string' && raw.length > 0) {
    const { id: _drop, _id: _drop2, ...rest } = entry;
    void _drop;
    void _drop2;
    return { id: raw, body: rest };
  }
  return { id: null, body: entry };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Apply seed docs to a collection through the admin surface. Each doc
 * lands at `${collection}/${id || generated}` via `setDocument`
 * (bypasses rules, schedules a per-session persistence flush). Errors
 * are collected per-doc — one bad doc never sinks the batch (mirrors
 * the seed tool's partial-success contract).
 */
export function applySeed(
  admin: AdminSeedSurface,
  collection: string,
  docs: SeedDoc[],
): ApplyResult {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) {
    return {
      applied: 0,
      failed: docs.length,
      errors: docs.map((d) => ({
        id: d.id || '(auto)',
        error: `Invalid collection id "${collection}".`,
      })),
    };
  }
  let applied = 0;
  const errors: ApplyResult['errors'] = [];
  for (const doc of docs) {
    const id = doc.id.trim() || generateDocId();
    try {
      if (!isValidDocId(id)) {
        errors.push({ id, error: `Invalid document id "${id}".` });
        continue;
      }
      admin.setDocument(`${coll}/${id}`, doc.data);
      applied++;
    } catch (e) {
      errors.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, failed: errors.length, errors };
}

export async function applySeedAsync(
  admin: AsyncAdminSeedSurface,
  collection: string,
  docs: SeedDoc[],
): Promise<ApplyResult> {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) {
    return {
      applied: 0,
      failed: docs.length,
      errors: docs.map((d) => ({
        id: d.id || '(auto)',
        error: `Invalid collection id "${collection}".`,
      })),
    };
  }
  let applied = 0;
  const errors: ApplyResult['errors'] = [];
  for (const doc of docs) {
    const id = doc.id.trim() || generateDocId();
    try {
      if (!isValidDocId(id)) {
        errors.push({ id, error: `Invalid document id "${id}".` });
        continue;
      }
      await admin.setDocument(`${coll}/${id}`, doc.data);
      applied++;
    } catch (e) {
      errors.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, failed: errors.length, errors };
}

/**
 * Delete every (non-phantom) document in a collection through the
 * admin surface. Phantom entries are synthesized parent docs with no
 * stored body — skipping them matches the Firestore tab's admin list
 * filter. Returns the count cleared.
 */
export function clearCollection(admin: AdminSeedSurface, collection: string): number {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) return 0;
  const docs = admin.listDocuments(coll).filter((d) => !d.phantom);
  let cleared = 0;
  for (const d of docs) {
    admin.deleteDocument(d.path);
    cleared++;
  }
  return cleared;
}

export async function clearCollectionAsync(
  admin: AsyncAdminSeedSurface,
  collection: string,
): Promise<number> {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) return 0;
  const docs = (await admin.listDocuments(coll)).filter((d) => !d.phantom);
  let cleared = 0;
  for (const d of docs) {
    await admin.deleteDocument(d.path);
    cleared++;
  }
  return cleared;
}

/**
 * Summarize what's currently seeded in a collection (id + field count)
 * for the panel's "what's seeded" readout. Reads through the same
 * admin list path the Firestore tab uses; phantom parents excluded.
 */
export function listSeeded(
  admin: AdminSeedSurface,
  collection: string,
): { id: string; fieldCount: number }[] {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) return [];
  return admin
    .listDocuments(coll)
    .filter((d) => !d.phantom)
    .map((d) => ({
      id: d.path.split('/').pop() ?? d.path,
      fieldCount:
        d.data && typeof d.data === 'object' ? Object.keys(d.data as object).length : 0,
    }));
}

export async function listSeededAsync(
  admin: AsyncAdminSeedSurface,
  collection: string,
): Promise<{ id: string; fieldCount: number }[]> {
  const coll = collection.trim();
  if (!isValidCollectionId(coll)) return [];
  return (await admin.listDocuments(coll))
    .filter((d) => !d.phantom)
    .map((d) => ({
      id: d.path.split('/').pop() ?? d.path,
      fieldCount:
        d.data && typeof d.data === 'object' ? Object.keys(d.data as object).length : 0,
    }));
}
