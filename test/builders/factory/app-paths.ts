/**
 * Where a factory run keeps its app, by who can write what.
 *
 * The run directory is every session's (`run-dir.ts`). Of the app's files
 * only the roles' clone lives there:
 *
 *   app/                the clone every role works in
 *   checks/             the harness's results, bound read-only over this path in each session
 *
 * The run's host directory, `<run dir>.host/`, is the harness's alone. Every
 * file the hourly check trusts is there, written through `host-files.ts`
 * and read back through a schema:
 *
 *   app.json                 what setup recorded: the source, the start commit, the tools' hashes
 *   packages/                the packed Pyric tarballs and the app's engine tarball
 *   tools/                   ffmpeg and ast-grep, each checked by hash before use
 *   git/                     a bare repo: each hour's commit is fetched into it, never checked out on the host
 *   checks/                  each check's result, the baseline, the reference screens, `latest`
 *   last-good.json           the last commit that passed every gate
 *   last-served.json         the commit the served copy shows, its failing gates and what changed
 *   served.json              the served copy's process, checked against /proc before any signal
 *   approved-components.txt  new components/ui files the brief approved
 *   copy-overrides.json      verbs and labels the copy check accepts
 *
 * The run's work directory, `<run dir>.work/`, holds the trees the check
 * builds and runs in: a fresh sandbox root per tree, exported from the
 * harness's repo, never bound into a session. They are kept;
 * `factory-summary` reports their size.
 */
import { join } from 'node:path';
import { hostDirOf } from './host-files.ts';

/** One sandbox's tree: its root, the exported repo in it, and its HOME, logs and network record. */
export interface Checkout {
  /** The sandbox's run root, its one writable directory. */
  root: string;
  repo: string;
  studio: string;
  home: string;
  logs: string;
  networkLog: string;
}

export interface AppPaths {
  runDir: string;
  host: string;
  work: string;
  record: string;
  packages: string;
  tools: string;
  gitDir: string;
  checks: string;
  latest: string;
  baseline: string;
  reference: string;
  lastGood: string;
  lastServed: string;
  served: string;
  approvedComponents: string;
  copyOverrides: string;
  /** Where roles see `checks`: the same directory, bound read-only in their sandbox. */
  roleChecks: string;
  /** The roles' clone, which setup installs in a sandbox rooted at the run directory. */
  app: Checkout;
}

export function checkoutAt(root: string): Checkout {
  const repo = join(root, 'repo');
  return { root, repo, studio: join(repo, 'studio'), home: join(root, 'home'), logs: join(root, 'logs'), networkLog: join(root, 'network.jsonl') };
}

export function workDirOf(runDir: string): string {
  return `${runDir}.work`;
}

export function appPaths(runDir: string): AppPaths {
  const host = hostDirOf(runDir);
  const checks = join(host, 'checks');
  const setup = join(runDir, 'setup');
  return {
    runDir,
    host,
    work: workDirOf(runDir),
    record: join(host, 'app.json'),
    packages: join(host, 'packages'),
    tools: join(host, 'tools'),
    gitDir: join(host, 'git'),
    checks,
    latest: join(checks, 'latest'),
    baseline: join(checks, 'baseline'),
    reference: join(checks, 'reference'),
    lastGood: join(host, 'last-good.json'),
    lastServed: join(host, 'last-served.json'),
    served: join(host, 'served.json'),
    approvedComponents: join(host, 'approved-components.txt'),
    copyOverrides: join(host, 'copy-overrides.json'),
    roleChecks: join(runDir, 'checks'),
    // Setup installs the roles' clone before any session exists, in a sandbox rooted at the run directory.
    app: { root: runDir, repo: join(runDir, 'app'), studio: join(runDir, 'app', 'studio'), home: join(setup, 'home'), logs: join(setup, 'logs'), networkLog: join(setup, 'network.jsonl') },
  };
}
