import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  type DataSnapshot,
} from '../../../src/database/index.js';

// rtdb-modular-* observations live under the 'rtdb-modular' surface subdirectory.
export const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'conformance',
  'observations',
  'rtdb-modular',
);

/** Observations that cannot be replayed against the sandbox, with the reason. */
export const NOT_APPLICABLE: Record<string, string> = {
  'rtdb-modular-ondisconnect-abrupt-exit.json':
    'requires terminating the writer process; the sandbox boundary is pinned as a documented divergence in M84',
};

export function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

export function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

export function referenceStringShape(value: string, path: string): Record<string, unknown> {
  const parsed = new URL(value);
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathMatches: parsed.pathname.endsWith(`/${path}`),
  };
}

export async function invocationShape(task: () => unknown): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = task();
  } catch (error) {
    return { timing: 'synchronous-throw', name: error instanceof Error ? error.name : typeof error };
  }
  try {
    await value;
    return { timing: 'resolved', name: null };
  } catch (error) {
    return { timing: 'asynchronous-reject', name: error instanceof Error ? error.name : typeof error };
  }
}

export function synchronousInvocationShape(task: () => unknown): Record<string, unknown> {
  try {
    task();
    return { timing: 'resolved', value: null };
  } catch (error) {
    return {
      timing: 'synchronous-throw',
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Matched keys in snapshot iteration order. */
export function snapKeys(snap: DataSnapshot): string[] {
  const out: string[] = [];
  snap.forEach((child) => {
    if (child.key) out.push(child.key);
    return false;
  });
  return out;
}

/** Matched values in snapshot iteration order. */
export function snapValues<T = unknown>(snap: DataSnapshot): T[] {
  const out: T[] = [];
  snap.forEach((child) => {
    out.push(child.val() as T);
    return false;
  });
  return out;
}

export const DENY_ALL = { rules: { '.read': 'false', '.write': 'false' } };
