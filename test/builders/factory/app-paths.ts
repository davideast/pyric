/**
 * Where a factory run keeps its app. Three checkouts of one repo, each with
 * its own install, so no role's work and no check trip over another's:
 *
 *   app/              the clone every role works in (the supervisor's `app/`)
 *   app.json          what app setup recorded: the source, its commit, the start commit
 *   packages/         the packed Pyric tarballs and the app's own engine tarball
 *   tools/            binaries an install script would have downloaded (ffmpeg)
 *   check/app/        the checkout the hourly check builds and starts
 *   served/app/       the checkout of the last good commit, served on the tailnet
 *   checks/hour-<n>/  each check's result, output, screenshots and copy report
 *   checks/latest     the most recent check's folder
 *   checks/baseline/  the start commit's screenshots and layout findings
 *   last-good.json    the last commit that passed, and what serves it
 *
 * `check/` and `served/` are each a sandbox's run root: the sandbox writes
 * its resolv.conf, hosts and network record there, beside the checkout.
 */
import { join } from 'node:path';

/** One checkout and its sandbox's files. */
export interface Checkout {
  /** The sandbox's run root. */
  root: string;
  /** The repo. */
  repo: string;
  /** Studio, inside the repo. */
  studio: string;
  home: string;
  logs: string;
  networkLog: string;
}

export interface AppPaths {
  runDir: string;
  record: string;
  packages: string;
  tools: string;
  app: Checkout;
  check: Checkout;
  served: Checkout;
  checks: string;
  latest: string;
  baseline: string;
  lastGood: string;
  approvedComponents: string;
  copyOverrides: string;
}

function checkoutAt(root: string, repo: string): Checkout {
  return {
    root,
    repo,
    studio: join(repo, 'studio'),
    home: join(root, 'home'),
    logs: join(root, 'logs'),
    networkLog: join(root, 'network.jsonl'),
  };
}

export function appPaths(runDir: string): AppPaths {
  const checks = join(runDir, 'checks');
  return {
    runDir,
    record: join(runDir, 'app.json'),
    packages: join(runDir, 'packages'),
    tools: join(runDir, 'tools'),
    // The supervisor fixes the roles' clone at `app/`, so its sandbox's root is the run directory and its files go in `setup/`.
    app: { ...checkoutAt(join(runDir, 'setup'), join(runDir, 'app')), root: runDir, networkLog: join(runDir, 'setup', 'network.jsonl') },
    check: checkoutAt(join(runDir, 'check'), join(runDir, 'check', 'app')),
    served: checkoutAt(join(runDir, 'served'), join(runDir, 'served', 'app')),
    checks,
    latest: join(checks, 'latest'),
    baseline: join(checks, 'baseline'),
    lastGood: join(runDir, 'last-good.json'),
    approvedComponents: join(runDir, 'approved-components.txt'),
    copyOverrides: join(runDir, 'copy-overrides.json'),
  };
}

export function hourDir(paths: AppPaths, hour: number): string {
  return join(paths.checks, `hour-${hour}`);
}
