import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FirestoreRulesException {
  rowId: string;
  conformanceDisposition: string;
  productionVerdict: 'ALLOW' | 'DENY';
  simulatorVerdict: 'ALLOW' | 'DENY';
  /** A probe limitation names the function production reported as not found;
   *  a pending fix has no diagnostic to check. */
  diagnosticFunction?: string;
  reason: string;
  /** The tracking issue or hunt finding ID, e.g. `#135` or `FS2-SIM-5a`. */
  issue: string;
}

/** The encoded filename is the sole authored case identity; the directory is the index. */
export function loadFirestoreRulesExceptions(): ReadonlyMap<string, FirestoreRulesException> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore-rules-exceptions');
  const files = existsSync(directory) ? readdirSync(directory) : [];
  const entries = files.filter((file) => file.endsWith('.json')).sort().map((file) => {
    const key = decodeURIComponent(file.slice(0, -'.json'.length));
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as FirestoreRulesException;
    return [key, record] as const;
  });
  const records = new Map(entries);
  if (records.size !== entries.length) throw new Error('Duplicate Firestore Rules exception identities');
  return records;
}
