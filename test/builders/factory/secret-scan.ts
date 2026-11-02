/**
 * The token scan, extended to the agent's credential. The credential never
 * enters the sandbox, so any of its secrets in what a session wrote is a
 * defect. Before the factory keeps anything of a run, it looks for each of
 * them in every file the agents wrote, with `filesContaining` from the
 * harness's own scan, and redacts kept copies with `copyRedacted`. What it
 * reports names files, never a value.
 */
import { relative } from 'node:path';
import { filesContaining, type OnUnreadable, type Secrets, type Skipped } from '../token-scan.ts';
import type { CredentialRead } from './agent.ts';

/** Every secret the scan looks for: the harness's own, and the agent credential's when it can be read. */
export function scannedSecrets(harness: readonly string[], credential: CredentialRead): string[] {
  const agent = credential.ok ? credential.credential.secrets : [];
  return [...new Set([...harness, ...agent])];
}

/** The files under each of `roots` that hold any secret, relative to `base`. */
export function secretHits(base: string, roots: readonly string[], secrets: Secrets, skip?: Skipped, onUnreadable?: OnUnreadable): string[] {
  return roots.flatMap((root) => filesContaining(root, secrets, skip, onUnreadable)).map((path) => relative(base, path)).sort();
}
