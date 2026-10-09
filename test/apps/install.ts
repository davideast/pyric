/**
 * Installs an app the way a user does: the app's own package.json, `npm
 * install`, real registry packages for everything that is not Pyric. The
 * Pyric packages come from packed tarballs, never from workspace sources.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The published packages, in the order scripts/pack-packages.sh packs them. */
const PUBLISHED_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
];

/** Files in an app directory that drive it and are not part of the app. */
const DRIVER_FILES = new Set(['scenario.ts', 'README.md', 'node_modules', '.pyric']);

export type Tarballs = Map<string, string>;

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

/** The tarball of each published package in `dir`, named as `npm pack` names them. */
export function tarballsIn(root: string, dir: string): Tarballs {
  const tarballs: Tarballs = new Map();
  for (const packageDir of PUBLISHED_PACKAGE_DIRS) {
    const manifest = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const file = resolve(dir, tarballName(manifest.name, manifest.version));
    if (!existsSync(file)) throw new Error(`missing packed package ${manifest.name}: ${file}`);
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, output }));
  });
}

/** Packs the published packages into dist/packages and returns their tarballs. */
export async function packWorkspace(root: string, build: boolean): Promise<Tarballs> {
  const args = ['scripts/pack-packages.sh', ...(build ? [] : ['--skip-build'])];
  const result = await runCommand('bash', args, { cwd: root });
  if (result.code !== 0) throw new Error(`packing failed (exit ${result.code}):\n${result.output}`);
  return tarballsIn(root, join(root, 'dist/packages'));
}

/**
 * Copies the app into `projectDir`, points its Pyric dependencies at the
 * tarballs, and runs `npm install`. The overrides pin every Pyric package to
 * its tarball, so the packages' dependencies on each other resolve locally too.
 */
export async function installApp(options: {
  appDir: string;
  projectDir: string;
  tarballs: Tarballs;
  npmCache: string;
}): Promise<CommandResult> {
  for (const entry of readdirSync(options.appDir)) {
    if (DRIVER_FILES.has(entry)) continue;
    cpSync(join(options.appDir, entry), join(options.projectDir, entry), { recursive: true });
  }
  const manifestPath = join(options.projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const pins = Object.fromEntries([...options.tarballs].map(([name, file]) => [name, `file:${file}`]));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (pins[name]) dependencies[name] = pins[name];
    }
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return runCommand('npm', [
    'install', '--no-audit', '--no-fund', '--loglevel=error', '--prefer-offline', '--cache', options.npmCache,
  ], { cwd: options.projectDir });
}
