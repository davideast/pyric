/**
 * Observation-exception loader.
 *
 * `exceptions/` is the index: one file per excepted observation, named
 * `<observation-name>.md`, whose entire body is the reason that observation is
 * allowed to exist without a citing registry row. The filename IS the key. This
 * replaces the hand-maintained `observationExceptions` record that used to live
 * in `registry/index.ts` — adding an exception is adding a file; the directory
 * is the list.
 *
 * An exception is the escape hatch for a captured prod observation whose matrix
 * rows have not landed yet (admin bootstrap captures), or an observation that
 * deliberately documents an upstream shape rather than a single implemented row.
 * compat:validate enforces that every key here matches a real observation file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Reads every `<name>.md` in this directory into a `{ observationName: reason }` record. */
export function loadObservationExceptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.md')).sort()) {
    const name = file.slice(0, -'.md'.length);
    const reason = readFileSync(join(HERE, file), 'utf8').trim();
    out[name] = reason;
  }
  return out;
}

/** The loaded exceptions, evaluated once. */
export const observationExceptions: Record<string, string> = loadObservationExceptions();
