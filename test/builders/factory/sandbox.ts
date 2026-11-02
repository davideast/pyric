/**
 * A sandbox for one step of the factory: the harness's own (`namespace.ts`),
 * rooted at a fresh directory of `<run>.work/` (or, during setup, the run
 * directory), with Playwright's browsers, the run's tarballs and the
 * harness's tools read-only and npm's shared cache under an overlay. It
 * stops when the step ends or the signal aborts, taking everything started
 * in it along.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import { playwrightBrowsersPath } from '../browser-server.ts';
import { startEgressNamespace, type EgressNamespace } from '../namespace.ts';
import type { AppPaths } from './app-paths.ts';
import { sandboxRunner, type Runner } from './exec.ts';
import { writeNewFile } from './host-files.ts';
import { optional } from './optional.ts';

export type SandboxStep<T> = (runner: Runner, namespace: EgressNamespace) => Promise<T>;

export interface SandboxSpec {
  /** The sandbox's one writable directory. */
  root: string;
  /** Where its holder records the network, and the HOME its commands get: both inside `root`. */
  networkLog: string;
  home: string;
  /** More directories it reads, such as the brief's walks. */
  readOnly?: readonly string[];
  /** More caches it writes, whose writes stay in the sandbox, such as bun's. */
  overlaid?: readonly string[];
  signal?: AbortSignal;
}

/** Opens a sandbox, runs `step` in it, and stops it. Tests pass one that runs on the host. */
export type SandboxOpener = <T>(spec: SandboxSpec, paths: AppPaths, step: SandboxStep<T>) => Promise<T>;

/** A sandbox spec for a fresh root: its HOME and network record inside it. */
export function specAt(root: string, signal?: AbortSignal, readOnly: readonly string[] = []): SandboxSpec {
  return { root, networkLog: join(root, 'network.jsonl'), home: join(root, 'home'), readOnly, ...optional('signal', signal) };
}

export const openSandbox: SandboxOpener = async (spec, paths, step) => {
  mkdirSync(spec.home, { recursive: true });
  writeNewFile(spec.networkLog, '');
  const namespace = await startEgressNamespace({
    networkLog: spec.networkLog,
    runRoot: spec.root,
    readOnly: [playwrightBrowsersPath(), paths.packages, paths.tools, ...(spec.readOnly ?? [])],
    overlaid: [npmCacheDir(), ...(spec.overlaid ?? [])],
  });
  const stop = () => void namespace.stop();
  spec.signal?.addEventListener('abort', stop, { once: true });
  try {
    return await step(sandboxRunner(namespace, spec.home, spec.signal), namespace);
  } finally {
    spec.signal?.removeEventListener('abort', stop);
    await namespace.stop();
  }
};
