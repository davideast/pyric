/**
 * The private-network entries this run added for its served copy, in
 * `<run>.host/private-network-entries.json`, so only those are removed: by
 * the run end, or by the served copy itself when its owner is gone.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { AppPaths } from './app-paths.ts';
import { readJson, writeJson } from './state-files.ts';
import { removeServed, tailscaleFrom } from './tailnet.ts';

const ENTRIES_SCHEMA = z.object({ ports: z.array(z.number().int()) }).strict();

function entriesFile(paths: AppPaths): string {
  return join(paths.host, 'private-network-entries.json');
}

export function recordEntries(paths: AppPaths, added: readonly number[]): void {
  if (added.length === 0) return;
  const earlier = readJson(entriesFile(paths), ENTRIES_SCHEMA)?.ports ?? [];
  writeJson(entriesFile(paths), { ports: [...new Set([...earlier, ...added])] });
}

/** Removes the entries this run added and forgets them; returns what the private network's CLI said. */
export function removeRecordedEntries(paths: AppPaths, env: NodeJS.ProcessEnv = process.env): string[] {
  const ports = readJson(entriesFile(paths), ENTRIES_SCHEMA)?.ports ?? [];
  if (ports.length === 0) return [];
  const lines = removeServed(ports, tailscaleFrom(env));
  writeJson(entriesFile(paths), { ports: [] });
  return lines;
}
