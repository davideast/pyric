import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from './private-job-tmpdir.ts';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const REAL_NODE = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();

export const PUBLISHED_NAMES = [
  'pyric',
  'pyric-admin',
  'create-pyric',
  '@pyric/cli',
  '@pyric/ui',
  '@pyric/live',
];

export const accessJson = (names: string[], permission = 'read-write') =>
  JSON.stringify(Object.fromEntries(names.map((name) => [name, permission])));
export const ALL_READ_WRITE = accessJson(PUBLISHED_NAMES);
export const FIVE_EXISTING = accessJson(PUBLISHED_NAMES.filter((name) => name !== '@pyric/live'));

export class TempDirTracker {
  private readonly dirs: string[] = [];

  create(label: string): string {
    const parent = createPrivateJobTmpDir(label);
    this.dirs.push(parent);
    const dir = join(parent, 'work');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  cleanup(): void {
    for (const directory of this.dirs.splice(0)) {
      removePrivateJobTmpDir(directory);
    }
  }
}

function envWithoutReleaseSettings(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'PYRIC_PUBLISH_SCOPE_WRITE',
    'PYRIC_PUBLISH_SKIP_GATES',
    'PYRIC_PUBLISH_TAG',
    'PYRIC_NPM_REGISTRY',
  ]) {
    delete env[name];
  }
  return env;
}

function defaultVersionForTarget(target?: 'pyric' | 'rules'): string {
  if (target === 'rules') return '0.1.0';
  return '0.1.0-alpha.9';
}

function readNonEmptyLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const trimmed = readFileSync(filePath, 'utf8').trim();
  if (trimmed === '') return [];
  return trimmed.split('\n');
}

export interface RunPublishOptions {
  skip?: boolean;
  dryRun?: boolean;
  packageTarget?: 'pyric' | 'rules';
  dryRunAfterPackage?: boolean;
  version?: string;
  failBunCommand?: string;
  failCommand?: string;
  publishTag?: string;
  npmRegistry?: string;
}

export function runPublish(tracker: TempDirTracker, options: RunPublishOptions = {}) {
  const work = tracker.create('pub-contract');
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(work, 'commands.log');
  const registryLog = join(work, 'registry.log');
  const fake = `#!/bin/bash
set -eu
name="$(basename "$0")"
echo "$name $*" >> "$COMMAND_LOG"
if [ "$name" = "npm" ]; then echo "\${NPM_CONFIG_REGISTRY:-}" >> "$REGISTRY_LOG"; fi
if [ "$name $*" = "bun run packages/conformance/src/print-fb-tag.ts" ]; then echo fb12.13; fi
if [ -n "\${FAIL_BUN_COMMAND:-}" ] && [ "$name $*" = "bun $FAIL_BUN_COMMAND" ]; then exit 17; fi
if [ -n "\${FAIL_COMMAND:-}" ] && [ "$name $*" = "$FAIL_COMMAND" ]; then exit 17; fi
`;
  for (const command of ['node', 'bun', 'npm', 'bash', 'cp']) {
    const path = join(bin, command);
    writeFileSync(path, fake);
    chmodSync(path, 0o755);
  }
  const args = [join(REPO_ROOT, 'scripts/publish-alpha.sh')];
  if (options.dryRun && !options.dryRunAfterPackage) args.push('--dry-run');
  if (options.packageTarget) args.push('--package', options.packageTarget);
  if (options.dryRun && options.dryRunAfterPackage) args.push('--dry-run');
  const requestedVersion = options.version ?? defaultVersionForTarget(options.packageTarget);
  args.push(requestedVersion);

  const env: NodeJS.ProcessEnv = {
    ...envWithoutReleaseSettings(),
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: log,
    REGISTRY_LOG: registryLog,
    FAIL_BUN_COMMAND: options.failBunCommand ?? '',
    FAIL_COMMAND: options.failCommand ?? '',
    PYRIC_PUBLISH_SKIP_GATES: options.skip ? '1' : '0',
    PYRIC_PUBLISH_TAG: options.publishTag ?? '',
    NPM_CONFIG_REGISTRY: 'http://workstation-proxy.internal:999/',
  };
  if (options.npmRegistry !== undefined) env.PYRIC_NPM_REGISTRY = options.npmRegistry;
  else delete env.PYRIC_NPM_REGISTRY;

  const result = spawnSync('/bin/bash', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  return {
    result,
    commands: readNonEmptyLines(log),
    registries: readNonEmptyLines(registryLog),
  };
}

export function runPack(
  tracker: TempDirTracker,
  out: string,
  stubs: Record<string, string>,
  extraArgs: string[] = [],
) {
  const work = tracker.create('pack-stub');
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const packArgs = [join(REPO_ROOT, 'scripts/pack-packages.sh'), '--out', out];
  if (!stubs.bash) {
    packArgs.push('--skip-build');
  }
  packArgs.push(...extraArgs);
  return spawnSync('/bin/bash', packArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

export function staleOutDir(tracker: TempDirTracker): string {
  const out = tracker.create('pack-out');
  writeFileSync(join(out, 'pyric-0.1.0-alpha.8.tgz'), 'an older pack');
  writeFileSync(join(out, 'proven.json'), '{}');
  writeFileSync(join(out, 'notes.txt'), "not the pack's");
  return out;
}

export const NPM_PACK_STUB = `if [ "$1" = pack ]; then
  dest="$4"; name=$(jq -r .name package.json); version=$(jq -r .version package.json)
  file="$(printf '%s' "\${name#@}" | tr / -)-\${version}.tgz"
  tmp=$(mktemp -d); mkdir -p "$tmp/package"; cp package.json "$tmp/package/"
  tar -czf "$dest/$file" -C "$tmp" package; rm -rf "$tmp"; echo "$file"; exit 0
fi
echo "npm stub: unexpected npm $*" >&2; exit 64`;

export function realStampRepo(tracker: TempDirTracker): string {
  const repo = tracker.create('real-stamp');
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q');
  for (const path of [
    'scripts/publish-alpha.sh',
    'scripts/lib/check-publish-version.mjs',
    'scripts/lib/check-publish-access.mjs',
    'scripts/lib/proven-stamp.mjs',
  ]) {
    if (!existsSync(join(REPO_ROOT, path))) continue;
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), readFileSync(join(REPO_ROOT, path)));
  }
  mkdirSync(join(repo, 'packages/rules'), { recursive: true });
  writeFileSync(
    join(repo, 'packages/rules/package.json'),
    JSON.stringify({ name: '@pyric/rules', version: '0.1.0' }),
  );
  for (const [dir, name] of [
    ['pyric', 'pyric'],
    ['pyric-admin', 'pyric-admin'],
    ['create-pyric', 'create-pyric'],
    ['cli', '@pyric/cli'],
    ['ui', '@pyric/ui'],
    ['live', '@pyric/live'],
  ]) {
    mkdirSync(join(repo, 'packages', dir ?? ''), { recursive: true });
    writeFileSync(
      join(repo, 'packages', dir ?? '', 'package.json'),
      JSON.stringify({ name, version: '0.1.0-alpha.9' }),
    );
  }
  writeFileSync(join(repo, '.gitignore'), 'dist/\nbin/\ncommands.log\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'release');
  return repo;
}

export function publishForReal(
  repo: string,
  env: Record<string, string> = {},
  options: { packageTarget?: 'pyric' | 'rules'; version?: string } = {},
) {
  const bin = join(repo, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(repo, 'commands.log');
  const packages = join(repo, 'dist/packages');
  const stubs: Record<string, string> = {
    npm: `echo "npm $*" >> "${log}"
if [ "$1" = whoami ]; then echo releaser; exit 0; fi
if [ "$1 $2 $3" = "access list packages" ]; then
  if [ "\${LISTING_FAILS:-}" = 1 ]; then echo "npm error code E403" >&2; exit 1; fi
  printf '%s\\n' "$ACCESS_JSON"; exit 0
fi
if [ "$1 $2 $3" = "access list collaborators" ]; then
  if [ "\${COLLABORATORS_FAIL:-}" = 1 ]; then echo "npm error code E403" >&2; exit 1; fi
  printf '%s\\n' "$COLLABORATORS_JSON"; exit 0
fi
if [ "$1" = view ]; then
  if [ "\${VIEW_FAILS:-}" = "$2" ]; then echo "npm error code ECONNRESET" >&2; exit 1; fi
  case " \${NEW_PACKAGES:-} " in *" $2 "*) echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/$2" >&2; exit 1;; esac
  echo "$2"; exit 0
fi
if [ "$1" = publish ]; then
  echo "uploaded $(basename "$2") $(cat "$2")" >> "${log}"
  if [ "\${RACE:-}" = 1 ]; then echo "swapped after the check" > "${packages}/pyric-cli-0.1.0-alpha.9.tgz"; fi
fi`,
    bun: `echo "bun $*" >> "${log}"
if [ "\${MIDGATE:-}" = 1 ] && [ "$1" = test/apps/run.ts ]; then
  if [ -f "${packages}/pyric-cli-0.1.0-alpha.9.tgz" ]; then echo "a concurrent repack" > "${packages}/pyric-cli-0.1.0-alpha.9.tgz"; fi
  if [ -f "${packages}/pyric-rules-0.1.0.tgz" ]; then echo "a concurrent repack" > "${packages}/pyric-rules-0.1.0.tgz"; fi
fi
if [ "\${TESTS_FAIL:-}" = 1 ] && [ "$*" = "run test" ]; then exit 1; fi
if [ "\${TESTS_FAIL:-}" = 1 ] && [ "$*" = "scripts/lib/rules-release-gate.ts proof" ]; then exit 1; fi`,
    bash: `echo "bash $*" >> "${log}"
if [ "$*" = "scripts/pack-packages.sh --package rules" ]; then
  mkdir -p "${packages}"; rm -f "${packages}"/*.tgz "${packages}"/*.json
  echo "packed pyric-rules" > "${packages}/pyric-rules-0.1.0.tgz"
  echo '{"packages":[]}' > "${packages}/manifest.json"
  ${REAL_NODE} "${repo}/scripts/lib/proven-stamp.mjs" record "${packages}" "${repo}" "$(git -C "${repo}" rev-parse HEAD)" true
elif [ "$1" = scripts/pack-packages.sh ]; then
  mkdir -p "${packages}"; rm -f "${packages}"/*.tgz "${packages}"/*.json
  for n in pyric pyric-admin create-pyric pyric-cli pyric-ui pyric-live; do echo "packed $n" > "${packages}/$n-0.1.0-alpha.9.tgz"; done
  echo '{"packages":[]}' > "${packages}/manifest.json"
  ${REAL_NODE} "${repo}/scripts/lib/proven-stamp.mjs" record "${packages}" "${repo}" "$(git -C "${repo}" rev-parse HEAD)" true
fi`,
  };
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(log, '');
  const args = [join(repo, 'scripts/publish-alpha.sh'), '--dry-run'];
  if (options.packageTarget) args.push('--package', options.packageTarget);
  const requestedVersion = options.version ?? defaultVersionForTarget(options.packageTarget);
  args.push(requestedVersion);

  const result = spawnSync('/bin/bash', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...envWithoutReleaseSettings(),
      ACCESS_JSON: ALL_READ_WRITE,
      COLLABORATORS_JSON: '{}',
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      PYRIC_PUBLISH_TAG: 'exp',
    },
  });
  const commands = readFileSync(log, 'utf8').split('\n');
  const uploads = commands.filter((line) => line.startsWith('uploaded '));
  return { result, uploads, commands };
}
