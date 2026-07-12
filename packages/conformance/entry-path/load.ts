/**
 * Entry-path program loader.
 *
 * `entry-path/` is the corpus: one canonical initialization program per
 * service, named `<service>.ts` — the filename IS the program's name (same
 * "directory is the index" convention `rigs/`, `probes/`, `surfaces/`, and
 * `exceptions/` already use). `expected-failures.ts` and `types.ts` are index
 * plumbing, not programs, and are excluded.
 *
 * Two independent readers exist over this same directory, deliberately kept
 * separate:
 *   - This file EXECUTES each program (dynamic `import()`) — the CLIFF gate
 *     (`../src/entry-path-gate.ts`) needs the live `run()` function.
 *   - `../src/entry-path-symbols.ts` reads each program's SOURCE TEXT and
 *     statically parses its import statements — it must never execute a
 *     program (a program that throws on import would break symbol
 *     extraction) and must not depend on this loader.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EntryPathProgramModule } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENTRY_PATH_DIR = HERE;

/** Files in `entry-path/` that are index plumbing, not corpus programs. */
const NON_PROGRAM_FILES = new Set(['load.ts', 'types.ts', 'expected-failures.ts']);

export interface EntryPathProgramFile {
  /** The program name — the filename minus `.ts`, e.g. `'auth'`. */
  name: string;
  /** Absolute path to the program's source file. */
  path: string;
}

/** Every `entry-path/<name>.ts` corpus program file, sorted by name. */
export function listEntryPathProgramFiles(): EntryPathProgramFile[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !NON_PROGRAM_FILES.has(f) && !f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f.slice(0, -'.ts'.length), path: join(HERE, f) }));
}

export interface LoadedEntryPathProgram extends EntryPathProgramFile {
  run: () => Promise<void>;
}

/**
 * Dynamically imports every corpus program and returns its `run()`. Throws
 * (naming the offending program) if a file does not export an async `run`
 * function — that is a corpus-authoring bug, not a RED program, and must
 * never be silently swallowed into a gate failure that looks like a real
 * conformance regression.
 */
export async function loadEntryPathPrograms(): Promise<LoadedEntryPathProgram[]> {
  const files = listEntryPathProgramFiles();
  const out: LoadedEntryPathProgram[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(file.path).href)) as { run?: unknown };
    if (typeof mod.run !== 'function') {
      throw new Error(`entry-path/${file.name}.ts does not export an async run(): Promise<void>`);
    }
    out.push({ ...file, run: mod.run as EntryPathProgramModule['run'] });
  }
  return out;
}
