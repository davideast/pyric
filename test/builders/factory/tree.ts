/**
 * The trees the hourly check builds and runs in. Each is a fresh directory
 * of `<run>.work/`, made with `mkdir` that fails when it exists, so no
 * earlier check or session left anything in it. The commit's files reach it
 * from the harness's bare repo as a tar (`git archive`), which the sandbox
 * unpacks itself: the host writes only the tar, into a directory nothing has
 * run in yet, and never follows a path the commit's files define. No tree
 * has a `.git`.
 *
 * The trees are kept after the check; `factory-summary` reports their size.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runStamp } from '../scratch.ts';
import type { AppPaths, Checkout } from './app-paths.ts';
import { checkoutAt } from './app-paths.ts';
import { mustRun, type Runner } from './exec.ts';
import { archiveCommit } from './git.ts';
import { makeHostDir } from './host-files.ts';

const TAR = 'tree.tar';
const UNPACK_TIMEOUT_MS = 5 * 60_000;

/** A new directory under `<run>.work/`, named for `label` and the time; never one that exists. */
export function newWorkRoot(paths: AppPaths, label: string): string {
  makeHostDir(paths.work, paths.work, paths.runDir);
  const root = join(paths.work, `${label}-${runStamp()}-${randomBytes(3).toString('hex')}`);
  mkdirSync(root, { mode: 0o700 });
  return root;
}

/** A fresh checkout root under `<run>.work/` with `commit`'s tar in it, ready to unpack in its sandbox. */
export function exportTree(paths: AppPaths, commit: string, label: string): Checkout {
  const checkout = checkoutAt(newWorkRoot(paths, label));
  archiveCommit(paths.gitDir, commit, join(checkout.root, TAR));
  return checkout;
}

/** Unpacks the tar into `repo/`, inside the sandbox. */
export async function unpackTree(runner: Runner, checkout: Checkout): Promise<void> {
  const script = 'mkdir repo logs sockets && tar -xf "$1" -C repo --no-same-owner --no-same-permissions';
  await mustRun(runner, { command: '/bin/sh', args: ['-c', script, 'sh', TAR], cwd: checkout.root, timeoutMs: UNPACK_TIMEOUT_MS }, 'unpacking the commit');
}
