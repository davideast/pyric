import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Observation {
  file: string;
  /** Actual `observations/<surfaceDir>/` owner. */
  surfaceDir: string;
  name: string;
  matrixRow: string;
  rowIds: string[];
  observedAt?: string;
  fbSdkVersion?: string;
  adminSdkVersion?: string;
  functionsSdkVersion?: string;
  behavior: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const OBS_DIR = dirname(fileURLToPath(import.meta.url));

function listObservationFiles(): { surfaceDir: string; file: string }[] {
  const entries: { surfaceDir: string; file: string }[] = [];
  for (const surfaceDir of readdirSync(OBS_DIR).sort()) {
    const dirPath = join(OBS_DIR, surfaceDir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).filter((name) => name.endsWith('.json')).sort()) {
      entries.push({ surfaceDir, file });
    }
  }
  return entries;
}

export function loadObservations(): Observation[] {
  return listObservationFiles().map(({ surfaceDir, file }) => {
    const raw = JSON.parse(readFileSync(join(OBS_DIR, surfaceDir, file), 'utf8')) as Record<string, unknown>;
    const name = String(raw.name ?? file.replace(/\.json$/, ''));
    return {
      file,
      surfaceDir,
      name,
      matrixRow: String(raw.matrixRow ?? ''),
      rowIds: Array.isArray(raw.rowIds) ? raw.rowIds.map(String) : [],
      observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : undefined,
      fbSdkVersion: typeof raw.fbSdkVersion === 'string' ? raw.fbSdkVersion : undefined,
      adminSdkVersion: typeof raw.adminSdkVersion === 'string' ? raw.adminSdkVersion : undefined,
      functionsSdkVersion: typeof raw.functionsSdkVersion === 'string' ? raw.functionsSdkVersion : undefined,
      behavior: (raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {}) as Record<string, unknown>,
      raw,
    } satisfies Observation;
  });
}
