/**
 * A sandbox for one step of the factory: the harness's own (`namespace.ts`),
 * rooted at a checkout's run root, with Playwright's browsers and the run's
 * tarballs read-only and npm's shared cache under an overlay. It stops when
 * the step ends, taking everything started in it along.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import { playwrightBrowsersPath } from '../browser-server.ts';
import { startEgressNamespace, type EgressNamespace } from '../namespace.ts';
import type { AppPaths } from './app-paths.ts';
import { sandboxRunner, type Runner } from './exec.ts';

export type SandboxStep<T> = (runner: Runner, namespace: EgressNamespace) => Promise<T>;

/** Opens a sandbox rooted at `runRoot`, runs `step` in it, and stops it. Tests pass one that runs on the host. */
export type SandboxOpener = <T>(runRoot: string, paths: AppPaths, step: SandboxStep<T>) => Promise<T>;

/** The network record of a sandbox rooted at `runRoot`. */
function networkLogIn(paths: AppPaths, runRoot: string): string {
  const checkouts = [paths.app, paths.check, paths.served];
  const owner = checkouts.find((checkout) => checkout.root === runRoot);
  return owner?.networkLog ?? `${runRoot}/network.jsonl`;
}

export const openSandbox: SandboxOpener = async (runRoot, paths, step) => {
  const networkLog = networkLogIn(paths, runRoot);
  mkdirSync(dirname(networkLog), { recursive: true });
  if (!existsSync(networkLog)) writeFileSync(networkLog, '');
  const home = `${dirname(networkLog)}/home`;
  mkdirSync(home, { recursive: true });
  const namespace = await startEgressNamespace({
    networkLog,
    runRoot,
    readOnly: [playwrightBrowsersPath(), paths.packages],
    overlaid: [npmCacheDir()],
  });
  try {
    return await step(sandboxRunner(namespace, home), namespace);
  } finally {
    await namespace.stop();
  }
};
