/**
 * Observation-exception loader.
 *
 * `exceptions/` is the index: one authored `ObservationException` record per
 * excepted observation, named `<observation-name>.ts`, exporting `{ reason,
 * until? }` (see `types.ts`). The filename IS the key. This replaces the
 * hand-maintained `observationExceptions` record that used to live in
 * `registry/index.ts` — adding an exception is adding a file; the directory
 * is the list.
 *
 * An exception is the escape hatch for a captured prod observation whose matrix
 * rows have not landed yet (admin bootstrap captures), or an observation that
 * deliberately documents an upstream shape rather than a single implemented row.
 * compat:validate enforces that every key here matches a real observation file.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`), the same technique
 * `surfaces/load.ts` uses — consumers (`ledger.ts`, `validate-registry.ts`)
 * read `observationExceptions` at module-evaluation time.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObservationException } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['load.ts', 'types.ts']);

/** Reads every `<name>.ts` in this directory into a `{ observationName: reason }`
 *  record — the flat shape every existing consumer (`ledger.ts`,
 *  `validate-registry.ts`) already expects. `until` is authored metadata, not
 *  consumed here; a future gate can read the typed records directly via
 *  `loadObservationExceptionRecords`. */
export function loadObservationExceptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, record] of loadObservationExceptionRecords()) {
    out[name] = record.reason;
  }
  return out;
}

/** Reads every `<name>.ts` in this directory into `[name, ObservationException][]`. */
export function loadObservationExceptionRecords(): [string, ObservationException][] {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !NON_RECORD_FILES.has(f)).sort();
  const entries: [string, ObservationException][] = [];
  for (const file of files) {
    const name = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as { exception?: ObservationException };
    if (!mod.exception || typeof mod.exception.reason !== 'string' || !mod.exception.reason.trim()) {
      throw new Error(`exceptions/${file}: does not export an 'exception' record with a non-empty 'reason'`);
    }
    entries.push([name, mod.exception]);
  }
  return entries;
}

/** The loaded exceptions, evaluated once. */
export const observationExceptions: Record<string, string> = loadObservationExceptions();
