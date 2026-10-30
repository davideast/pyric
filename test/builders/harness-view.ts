/**
 * What of the harness's repo a run's sandbox sees. A builder works from
 * pyric's public docs and packed packages, so the sandbox never gets the
 * repo: not its packages' sources, its tests, its internals or its git
 * history. What a builder can read of pyric is what a real install of the
 * published packages holds, which includes their `src/` under
 * `node_modules/pyric*`. It gets, read-only and at the paths the host has
 * them:
 *
 * - `test/builders`, the harness's own code, which runs inside: the run
 *   phase, the recorder, the sandbox inventory, the docs export and the
 *   canary's plants;
 * - the few repo files that code imports: `test/apps`' process driver and
 *   its helpers, and the CLI's Google endpoint catalog, which the recorder
 *   classifies hosts with;
 * - the packages that code imports (zod and Playwright's client), each with
 *   its dependencies, at `node_modules/<name>`.
 *
 * Everything else a run needs is bound by its caller: the packed packages,
 * Playwright's browsers, the toolchain, and the run root, which holds the
 * brief and the public docs. A file the harness's code starts importing
 * inside the sandbox must be added here: `harness-view.test.ts` walks the
 * imports of every entry point that runs inside, and fails on one that isn't.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/+$/, '');

/** The repo paths the harness's code runs or imports inside a sandbox. */
export const HARNESS_FILES: readonly string[] = [
  'test/builders',
  'test/apps/driver.ts',
  'test/apps/install.ts',
  'test/apps/nested-projects.ts',
  'test/apps/unreaped-exit.ts',
  'packages/cli/test/blackholed-port.ts',
  'packages/cli/src/google-endpoints.ts',
  'packages/cli/package.json',
];

/** The packages the harness's code imports inside a sandbox. */
export const HARNESS_PACKAGES: readonly string[] = ['zod', '@playwright/test'];

/** A host path bound read-only at another path inside the sandbox. */
export interface View {
  source: string;
  dest: string;
}

/** Where Node finds `name` from `dir`: the first `node_modules/<name>` walking up. */
function findPackage(dir: string, name: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    const isFileSystemRoot = dirname(current) === current;
    if (isFileSystemRoot) return undefined;
  }
}

/**
 * A package's dependencies. Optional ones are left out: the harness runs on
 * Linux, and Playwright's one (fsevents) is macOS-only.
 */
function dependencyNames(packageDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {});
}

/**
 * Each package `names` needs, itself or as a dependency, by name, at its
 * real directory on the host. Throws when one is missing, or when two need
 * different copies of a package, since the view binds one per name.
 */
export function packageClosure(fromDir: string, names: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string, name: string) => {
    const at = findPackage(dir, name);
    if (at === undefined) throw new Error(`the harness needs ${name} inside the sandbox, and no node_modules above ${dir} has it`);
    const real = realpathSync(at);
    const earlier = found.get(name);
    if (earlier === real) return;
    const isSecondCopy = earlier !== undefined;
    if (isSecondCopy) throw new Error(`the harness needs two copies of ${name} inside the sandbox (${earlier} and ${real}), and binds one per name`);
    found.set(name, real);
    for (const dependency of dependencyNames(real)) visit(real, dependency);
  };
  for (const name of names) visit(fromDir, name);
  return found;
}

/**
 * The harness's view of the repo: its files, bound where they are, and its
 * packages, each bound at `<repo>/node_modules/<name>` whatever layout the
 * install used, so Node finds every one from the harness's code.
 */
export function harnessView(repoRoot: string = REPO_ROOT): { readOnly: string[]; views: View[] } {
  const packages = packageClosure(join(repoRoot, 'test', 'builders'), HARNESS_PACKAGES);
  return {
    readOnly: HARNESS_FILES.map((path) => join(repoRoot, path)),
    views: [...packages].map(([name, source]) => ({ source, dest: join(repoRoot, 'node_modules', name) })),
  };
}
