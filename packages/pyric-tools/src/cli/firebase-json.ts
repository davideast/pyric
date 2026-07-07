/**
 * Minimal `firebase.json` / `.firebaserc` reader for the CLI.
 *
 * Surfaces only the fields the subcommands actually touch — the
 * full firebase.json schema is huge and a full parse isn't needed
 * for any current subcommand. New fields land alongside the
 * subcommand that consumes them.
 *
 * `.firebaserc` carries the project id under `projects.default`;
 * the standard Firebase CLI uses the same convention.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FirebaseJson {
  firestore?: {
    rules?: string;
    indexes?: string;
    database?: string;
  };
  /** Realtime Database rules path plus optional explicit instance URL. */
  database?: {
    rules?: string;
    url?: string;
  };
  hosting?: unknown;
  functions?: unknown;
  /** Storage rules + (optional) target bucket. A single object, or an array for
   *  multi-bucket projects. `rules` is a path; `bucket` overrides the default
   *  `{projectId}.firebasestorage.app`. */
  storage?: { rules?: string; bucket?: string } | Array<{ rules?: string; bucket?: string }>;
}

export interface FirebaseRc {
  projects?: {
    default?: string;
    [alias: string]: string | undefined;
  };
  /**
   * Deploy-target maps, keyed project → resource type → target name →
   * resource ids (mirrors firebase-tools' RCData,
   * clones/firebase-tools/src/rc.ts:28-36). Only `hosting` (target →
   * site ids) is consumed today.
   */
  targets?: {
    [projectId: string]: {
      [targetType: string]: {
        [targetName: string]: string[] | undefined;
      } | undefined;
    } | undefined;
  };
}

/**
 * Read + parse `firebase.json` from `cwd`. Throws when missing — every
 * subcommand that needs project metadata expects a present file.
 */
export async function readFirebaseJson(cwd: string = process.cwd()): Promise<FirebaseJson> {
  const path = join(cwd, 'firebase.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`pyric: no firebase.json found at ${path}. Run \`pyric init\` to scaffold one.`);
    }
    throw e;
  }
  try {
    return JSON.parse(raw) as FirebaseJson;
  } catch (e) {
    throw new Error(
      `pyric: failed to parse firebase.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Read + parse `.firebaserc` from `cwd`. Returns null when missing —
 * the project id can also come from `--project` / `PYRIC_PROJECT`, so
 * absence is not fatal at this layer.
 */
export async function readFirebaseRc(cwd: string = process.cwd()): Promise<FirebaseRc | null> {
  const path = join(cwd, '.firebaserc');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as FirebaseRc;
  } catch (e) {
    throw new Error(
      `pyric: failed to parse .firebaserc: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
