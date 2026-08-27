/**
 * Reader for the optional project-level `pyric.json` configuration file.
 *
 * Configures defaults for `pyric sandbox` (such as a default `command`,
 * custom `port`, or explicit `rules` paths) without requiring CLI flags
 * or magic process sniffing.
 */

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PyricRulesConfig {
  firestore?: string;
  database?: string;
  storage?: string;
}

export interface PyricConfig {
  /** Default command to execute under the sandbox if none is passed on CLI. */
  command?: string;
  /** Local port to bind the Pyric sandbox host. */
  port?: number;
  /** Path to Firestore, RTDB, or Storage rules files. */
  rules?: string | PyricRulesConfig;
  /** Project ID label for emulation. */
  project?: string;
}

export async function readPyricConfig(cwd: string = process.cwd()): Promise<PyricConfig> {
  const path = join(cwd, 'pyric.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    return JSON.parse(raw) as PyricConfig;
  } catch (e) {
    throw new Error(
      `pyric: failed to parse pyric.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function readPyricConfigSync(cwd: string = process.cwd()): PyricConfig {
  const path = join(cwd, 'pyric.json');
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as PyricConfig;
  } catch (e) {
    throw new Error(
      `pyric: failed to parse pyric.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
