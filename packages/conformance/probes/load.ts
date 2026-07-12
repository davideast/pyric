/**
 * Probe file lister.
 *
 * `probes/<surface>/<name>.ts` is the twin tree to `observations/<surface>/
 * <name>.json`: where a probe exists, its surface subdirectory must match the
 * observation it produces. This walks every surface subdirectory under
 * `probes/` and returns `{ surfaceDir, name }` for each `.ts` file (`name` is
 * the filename minus the extension — the twin-path validator rule compares it
 * directly against an observation's `name`).
 *
 * This is a filename lister, not a probe-record loader: it does not
 * dynamic-import the files (no `observe()` execution, no `Probe` typing).
 * Runners that need the actual probe records (e.g. `src/admin-app-probes.ts`)
 * keep their own dynamic-import loader scoped to the one surface they run;
 * this lister exists only so `validate-registry.ts` can check the twin-path
 * invariant across every surface without importing runnable probe code.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_FILE = 'load.ts';

export interface ProbeFile {
  /** The surface subdirectory the probe file lives under (`probes/<surfaceDir>/`). */
  surfaceDir: string;
  /** The probe's filename minus `.ts` — pairs 1:1 with an observation's `name`. */
  name: string;
}

export function listProbeFiles(): ProbeFile[] {
  const entries: ProbeFile[] = [];
  for (const surfaceDir of readdirSync(HERE).sort()) {
    if (surfaceDir === SELF_FILE) continue;
    const dirPath = join(HERE, surfaceDir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith('.ts')).sort()) {
      entries.push({ surfaceDir, name: file.slice(0, -'.ts'.length) });
    }
  }
  return entries;
}
