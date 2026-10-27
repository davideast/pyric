import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One case where the evaluator's verdict differs from the captured production verdict. */
export interface StorageRulesVerdictException {
  kind: 'verdict';
  rowId: string;
  productionVerdict: 'ALLOW' | 'DENY';
  evaluatorVerdict: 'ALLOW' | 'DENY';
  reason: string;
  /** The tracking row, issue or hunt finding ID, e.g. `storage-rules#131` or `ST-H1-3`. */
  issue: string;
}

/** A scenario production compiles and evaluates but pyric refuses to parse. */
export interface StorageRulesParseException {
  kind: 'parse';
  rowId: string;
  /** A substring of the parse error pyric reports today. */
  localError: string;
  reason: string;
  issue: string;
}

export type StorageRulesException = StorageRulesVerdictException | StorageRulesParseException;

/**
 * Load the pinned Storage rules divergences. The encoded filename is the pin's
 * identity: `<observation> :: <case>` for a verdict pin and `<observation>` for
 * a parse pin. The directory is the index, so each pin is added or removed as
 * one file.
 */
export function loadStorageRulesExceptions(): ReadonlyMap<string, StorageRulesException> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage-rules-exceptions');
  const files = existsSync(directory) ? readdirSync(directory) : [];
  const entries = files.filter((file) => file.endsWith('.json')).sort().map((file) => {
    const key = decodeURIComponent(file.slice(0, -'.json'.length));
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as StorageRulesException;
    return [key, record] as const;
  });
  const records = new Map(entries);
  if (records.size !== entries.length) throw new Error('Duplicate Storage Rules exception identities');
  return records;
}
