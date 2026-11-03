/**
 * The token scan, extended to the agent's credential and the provider key.
 * Neither enters a sandbox. The credential never
 * enters the sandbox, so any of its secrets in what a session wrote is a
 * defect. Before the factory keeps anything of a run, it looks for each of
 * them in every file the agents wrote, with `filesContaining` from the
 * harness's own scan, and redacts kept copies with `copyRedacted`. What it
 * reports names files, never a value.
 */
import { relative } from 'node:path';
import { filesContaining, type OnUnreadable, type Secrets, type Skipped } from '../token-scan.ts';
import type { CredentialRead } from './agent.ts';
import { workDirOf } from './app-paths.ts';
import { hostDirOf } from './host-files.ts';
import type { ProviderKeyRead } from './provider-forwarder.ts';

/** Every secret the scan looks for: the harness's own, the agent credential's when it can be read, and the provider key when the run has one. */
export function scannedSecrets(harness: readonly string[], credential: CredentialRead, provider?: ProviderKeyRead): string[] {
  const agent = credential.ok ? credential.credential.secrets : [];
  const key = provider?.ok === true ? [provider.key] : [];
  return [...new Set([...harness, ...agent, ...key])];
}

/** Every directory of a run the scan reads: the run's own, and the harness's `.host` and `.work` beside it. */
export function runScanRoots(runDir: string): string[] {
  return [runDir, hostDirOf(runDir), workDirOf(runDir)];
}

/** The files under each of `roots` that hold any secret, relative to `base`. */
export function secretHits(base: string, roots: readonly string[], secrets: Secrets, skip?: Skipped, onUnreadable?: OnUnreadable): string[] {
  return roots.flatMap((root) => filesContaining(root, secrets, skip, onUnreadable)).map((path) => relative(base, path)).sort();
}
