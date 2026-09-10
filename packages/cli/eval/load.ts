/**
 * Record loaders for the corpus and the matrix. Both directories follow the
 * project's record convention: the directory is the index, the filename is the
 * key, and no hand-maintained aggregate lists the members. A record whose `id`
 * disagrees with its filename is rejected, because the filename is the join key
 * and must exist nowhere else.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvalRow, EvalTask } from './types.js';

const DEFAULT_CORPUS_DIR = resolve(import.meta.dirname, 'corpus');
const DEFAULT_MATRIX_DIR = resolve(import.meta.dirname, 'matrix');

export class RecordIdMismatchError extends Error {
  constructor(
    public readonly file: string,
    public readonly declaredId: unknown,
  ) {
    super(`record ${file} declares id ${JSON.stringify(declaredId)}, expected the filename key`);
    this.name = 'RecordIdMismatchError';
  }
}

/** Filenames under `dir` that are records, sorted by their stable key. */
function recordKeys(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`no record directory at ${dir}`);
  const entries = readdirSync(dir, { withFileTypes: true });
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    keys.push(entry.name.slice(0, -3));
  }
  keys.sort();
  return keys;
}

/**
 * Load every record in `dir` as `{ key: record }`, asserting each record's `id`
 * equals its filename key.
 */
async function loadRecords<T extends { id: string }>(dir: string): Promise<Map<string, T>> {
  const records = new Map<string, T>();
  for (const key of recordKeys(dir)) {
    const file = join(dir, `${key}.ts`);
    const module = (await import(pathToFileURL(file).href)) as { default?: T };
    const record = module.default;
    if (record === undefined || record.id !== key) {
      throw new RecordIdMismatchError(file, record?.id);
    }
    records.set(key, record);
  }
  return records;
}

/** Every corpus task, keyed by task id. */
export async function loadTasks(dir: string = DEFAULT_CORPUS_DIR): Promise<Map<string, EvalTask>> {
  return loadRecords<EvalTask>(dir);
}

/** Every matrix row, keyed by row id. */
export async function loadRows(dir: string = DEFAULT_MATRIX_DIR): Promise<Map<string, EvalRow>> {
  return loadRecords<EvalRow>(dir);
}

/**
 * Narrow a loaded record set to the ids named on the command line. An empty or
 * absent selection keeps every record; an unknown id is an error rather than a
 * silent skip, because a typo would otherwise quietly shrink a run.
 */
export function selectRecords<T>(records: Map<string, T>, selection: string[] | undefined): T[] {
  if (selection === undefined || selection.length === 0) return [...records.values()];
  const selected: T[] = [];
  for (const id of selection) {
    const record = records.get(id);
    if (record === undefined) {
      throw new Error(`unknown record id: ${id}. known ids: ${[...records.keys()].join(', ')}`);
    }
    selected.push(record);
  }
  return selected;
}
