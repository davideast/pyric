/**
 * The Realtime Database instances a project's firebase.json names for the
 * live project: each `database[].instance`, and each `database[].target`
 * through `.firebaserc`'s `targets.<project>.database.<target>`. The Admin
 * Realtime Database row lets these through its instance check beside
 * `<project>-default-rtdb` and `<project>` (ADR 0022, amendment 2026-11-07).
 * An app's own `databaseURL` names no instance here: live mode reads it only
 * at the call, so an instance outside the defaults must be listed in
 * firebase.json.
 *
 * The register reads it once at start, so it reads the two files directly
 * and never throws: a file that is missing or unreadable names nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function fieldOf(subject: unknown, field: string): unknown {
  const isRecord = typeof subject === 'object' && subject !== null;
  return isRecord ? (subject as Record<string, unknown>)[field] : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** The instances `.firebaserc` maps `target` to for `projectId`. */
function targetInstances(firebaserc: unknown, projectId: string, target: string): string[] {
  const targets = fieldOf(fieldOf(fieldOf(firebaserc, 'targets'), projectId), 'database');
  return strings(fieldOf(targets, target));
}

/** The instances firebase.json in `projectRoot` names for `projectId`, lowercase, each once. */
export function configuredDatabaseInstances(projectRoot: string, projectId: string): string[] {
  const database = fieldOf(readJson(join(projectRoot, 'firebase.json')), 'database');
  const entries = Array.isArray(database) ? database : [];
  const firebaserc = readJson(join(projectRoot, '.firebaserc'));
  const named = entries.flatMap((entry: unknown) => {
    const instance = fieldOf(entry, 'instance');
    const target = fieldOf(entry, 'target');
    if (typeof instance === 'string') return [instance];
    return typeof target === 'string' ? targetInstances(firebaserc, projectId, target) : [];
  });
  return [...new Set(named.filter((name) => name !== '').map((name) => name.toLowerCase()))];
}
