import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '..');
const workDirs: string[] = [];
afterEach(() => {
  for (const directory of workDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runPublish(
  options: { skip?: boolean; dryRun?: boolean; failBunCommand?: string; failCommand?: string; publishTag?: string; npmRegistry?: string } = {},
) {
  const work = mkdtempSync(join(tmpdir(), 'pyric-publish-contract-'));
  workDirs.push(work);
  const bin = join(work, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
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
  const args = [join(root, 'scripts/publish-alpha.sh')];
  if (options.dryRun) args.push('--dry-run');
  args.push('0.1.0-alpha.9');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    cwd: root,
    encoding: 'utf8',
    env,
  });
  const registries = Bun.file(registryLog).size > 0 ? readFileSync(registryLog, 'utf8').trim().split('\n') : [];
  return { result, commands: readFileSync(log, 'utf8').trim().split('\n'), registries };
}

const PACK = 'bash scripts/pack-packages.sh';
const PACKAGING_GATE = 'bash scripts/packaging-test.sh --packages dist/packages';

describe('alpha publish safety contract', () => {
  test('proves the tree before the first irreversible publish', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const tests = commands.indexOf('bun run test');
    const pack = commands.indexOf(PACK);
    const packaging = commands.indexOf(PACKAGING_GATE);
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(tests).toBeLessThan(pack);
    expect(pack).toBeLessThan(packaging);
    expect(packaging).toBeLessThan(publish);
  });

  test('packs once, and the packaging gate tests those tarballs instead of building and packing its own', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    expect(commands.filter((command) => command.startsWith(PACK))).toEqual([PACK]);
    expect(commands).not.toContain('bun run test:packaging');
    expect(commands.filter((command) => command.startsWith('bash scripts/packaging-test.sh'))).toEqual([PACKAGING_GATE]);
    const pack = commands.indexOf(PACK);
    const rebuildsOrRepacks = commands.slice(pack + 1).filter((command) =>
      command.startsWith('bash scripts/build.sh') || command.startsWith('npm pack') || command === 'bun run build');
    expect(rebuildsOrRepacks).toEqual([]);
  });

  test('every publish uploads a copy of a tarball the pack wrote, from the directory the last check verified', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const uploads = commands.filter((command) => command.startsWith('npm publish ')).map((command) => command.split(' ')[2] ?? '');
    const names = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui'].map((name) => `${name}-0.1.0-alpha.9.tgz`);
    expect(uploads.map((upload) => upload.split('/').pop())).toEqual(names);
    const uploadDir = uploads[0]?.slice(0, uploads[0].lastIndexOf('/')) ?? '';
    expect(uploadDir).not.toBe(join(root, 'dist/packages'));
    expect(uploads.every((upload) => upload.startsWith(`${uploadDir}/`))).toBe(true);
    const lastVerify = commands.filter((command) => command.includes('proven-stamp.mjs verify')).pop();
    expect(lastVerify).toContain(`verify ${uploadDir} 0.1.0-alpha.9`);
  });

  test('a failed packaging gate prevents every publish', () => {
    const { result, commands } = runPublish({ failCommand: PACKAGING_GATE });
    expect(result.status).toBe(17);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });

  test('runs the app scenarios on the packed tarballs before the first publish', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const pack = commands.indexOf('bash scripts/pack-packages.sh');
    const apps = commands.indexOf('bun test/apps/run.ts --packages dist/packages');
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(pack).toBeGreaterThanOrEqual(0);
    expect(pack).toBeLessThan(apps);
    expect(apps).toBeLessThan(publish);
  });

  test('a failed app scenario prevents every publish', () => {
    const { result, commands } = runPublish({ failBunCommand: 'test/apps/run.ts --packages dist/packages' });
    expect(result.status).toBe(17);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });

  test('a failed proof prevents every publish', () => {
    const { result, commands } = runPublish({ failBunCommand: 'run test' });
    expect(result.status).toBe(17);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });

  test('the explicit rerun escape hatch skips the proofs and the pack, and uploads the tarballs they proved', () => {
    const { result, commands } = runPublish({ skip: true });
    expect(result.status).toBe(0);
    expect(commands).not.toContain('bun run test');
    expect(commands).not.toContain(PACKAGING_GATE);
    expect(commands).not.toContain('bun test/apps/run.ts --packages dist/packages');
    expect(commands.some((command) => command.startsWith(PACK))).toBe(false);
    expect(commands.filter((command) => command.startsWith('npm publish '))).toHaveLength(5);
  });

  test('the packaging gate given --packages neither builds nor packs', () => {
    const work = mkdtempSync(join(tmpdir(), 'pyric-packaging-gate-'));
    workDirs.push(work);
    const bin = join(work, 'bin');
    const packages = join(work, 'packages');
    Bun.spawnSync(['mkdir', '-p', bin, packages]);
    const log = join(work, 'commands.log');
    writeFileSync(log, '');
    for (const command of ['bash', 'npm', 'bun']) {
      const path = join(bin, command);
      writeFileSync(path, `#!/bin/bash\necho "$(basename "$0") $*" >> "$COMMAND_LOG"\n`);
      chmodSync(path, 0o755);
    }
    // A manifest naming tarballs that are not there: the gate stops at the first
    // one it looks up, after the point where it would otherwise build and pack.
    writeFileSync(join(packages, 'manifest.json'), JSON.stringify({ packages: [] }));
    const result = spawnSync('/bin/bash', [join(root, 'scripts/packaging-test.sh'), '--packages', packages], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, TMPDIR: work },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`build and pack skipped: testing the tarballs in ${packages}`);
    expect(result.stderr).toContain('names no packed pyric@');
    const commands = readFileSync(log, 'utf8');
    expect(commands).not.toContain('scripts/build.sh');
    expect(commands).not.toContain('pack-packages.sh');
    expect(commands).not.toContain('npm pack');
  });

  test('dry-run proves authentication and package shape without mutating the registry', () => {
    const { result, commands } = runPublish({ dryRun: true });
    expect(result.status).toBe(0);
    expect(commands).toContain('npm whoami --registry=https://registry.npmjs.org/');
    expect(commands.filter((command) => command.startsWith('npm publish '))).toHaveLength(5);
    expect(
      commands
        .filter((command) => command.startsWith('npm publish '))
        .every((command) => command.includes(' --dry-run')),
    ).toBe(true);
    expect(commands).toContain('bun run compat:check');
    expect(commands).toContain('bun run packages/conformance/src/print-fb-tag.ts');
    expect(commands.some((command) => command.startsWith('npm dist-tag add '))).toBe(false);
  });

  test('the generated release checklist requires preflight before publishing', () => {
    const script = readFileSync(join(root, 'scripts/prepare-release.sh'), 'utf8');
    const checklist = script.slice(script.indexOf('BODY_FILE='));
    const preflight = checklist.indexOf('bun run release:preflight');
    const publish = checklist.indexOf('bash scripts/publish-alpha.sh');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(publish);
    expect(checklist).not.toContain('OTP-capable');
  });

  test('prepare-release opens the release PR with the ci-packaging label', () => {
    const script = readFileSync(join(root, 'scripts/prepare-release.sh'), 'utf8');
    expect(script).toContain('gh pr create');
    expect(script).toContain('--label ci-packaging');
  });

  test('supports publishing under the next tag without moving latest or alpha (#689)', () => {
    const { result, commands } = runPublish({ skip: true, publishTag: 'next' });
    expect(result.status).toBe(0);
    expect(commands.filter((c) => c.startsWith('npm publish ')).every((c) => c.includes('--tag next'))).toBe(true);
    const distTagAdds = commands.filter((c) => c.startsWith('npm dist-tag add '));
    expect(distTagAdds.every((c) => !c.endsWith(' latest'))).toBe(true);
    expect(distTagAdds.every((c) => !c.endsWith(' alpha'))).toBe(true);
    expect(distTagAdds.some((c) => c.endsWith(' next'))).toBe(true);
  });

  test('an experimental tag moves only itself: not latest, alpha, next, or the fb certificate', () => {
    const { result, commands } = runPublish({ skip: true, publishTag: 'exp' });
    expect(result.status).toBe(0);
    expect(commands.filter((c) => c.startsWith('npm publish ')).every((c) => c.includes('--tag exp'))).toBe(true);
    const distTagAdds = commands.filter((c) => c.startsWith('npm dist-tag add '));
    expect(distTagAdds.length).toBeGreaterThan(0);
    expect(distTagAdds.every((c) => c.endsWith(' exp'))).toBe(true);
    expect(commands).not.toContain('bun run compat:check');
  });

  test('the default latest release still moves latest, alpha, and the fb certificate', () => {
    const { result, commands } = runPublish({ skip: true });
    expect(result.status).toBe(0);
    const distTagAdds = commands.filter((c) => c.startsWith('npm dist-tag add '));
    expect(distTagAdds.some((c) => c.endsWith(' latest'))).toBe(true);
    expect(distTagAdds.some((c) => c.endsWith(' alpha'))).toBe(true);
    expect(distTagAdds.some((c) => c.endsWith(' fb12.13'))).toBe(true);
  });

  test('pins NPM_CONFIG_REGISTRY to registry.npmjs.org even when ambient env points elsewhere', () => {
    const { result, registries } = runPublish({ skip: true, publishTag: 'exp' });
    expect(result.status).toBe(0);
    expect(registries.length).toBeGreaterThan(0);
    expect(registries.every((r) => r === 'https://registry.npmjs.org/')).toBe(true);

    const custom = runPublish({ skip: true, publishTag: 'exp', npmRegistry: 'http://127.0.0.1:4873/' });
    expect(custom.result.status).toBe(0);
    expect(custom.registries.every((r) => r === 'http://127.0.0.1:4873/')).toBe(true);
  });
});

const UPLOADED = 'pyric pyric-admin create-pyric pyric-cli pyric-ui';
const STAMP_WRITE = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} write ${join(root, 'dist/packages')} 0.1.0-alpha.9 ${root} ${UPLOADED}`;
const STAMP_VERIFY = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} verify ${join(root, 'dist/packages')} 0.1.0-alpha.9 ${root} ${UPLOADED}`;

describe('the proven-tarball stamp', () => {
  test('every gate passes, then the tarballs are stamped, then the first upload', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const apps = commands.indexOf('bun test/apps/run.ts --packages dist/packages');
    const stamp = commands.indexOf(STAMP_WRITE);
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(apps).toBeGreaterThanOrEqual(0);
    expect(apps).toBeLessThan(stamp);
    expect(stamp).toBeLessThan(publish);
    expect(commands).not.toContain(STAMP_VERIFY);
  });

  test('a gate-skipping rerun checks the stamp first, before the release smoke, and does not stamp', () => {
    const { result, commands } = runPublish({ skip: true });
    expect(result.status).toBe(0);
    const verify = commands.indexOf(STAMP_VERIFY);
    const smoke = commands.findIndex((command) => command.startsWith('bash scripts/release-smoke.sh'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(smoke);
    expect(commands).not.toContain(STAMP_WRITE);
  });

  test('a gate-skipping rerun whose tarballs the stamp does not match uploads nothing', () => {
    const { result, commands } = runPublish({ skip: true, failCommand: STAMP_VERIFY });
    expect(result.status).toBe(17);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });
});

/** The real tools, found before a test puts its stubs first on PATH. */
const REAL_NODE = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();

/** Run the real pack-packages.sh with stubbed tools, into `out`. */
function runPack(out: string, stubs: Record<string, string>) {
  const work = mkdtempSync(join(tmpdir(), 'pyric-pack-'));
  workDirs.push(work);
  const bin = join(work, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return spawnSync('/bin/bash', [join(root, 'scripts/pack-packages.sh'), '--out', out, ...(stubs.bash ? [] : ['--skip-build'])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

function staleOutDir(): string {
  const out = mkdtempSync(join(tmpdir(), 'pyric-pack-out-'));
  workDirs.push(out);
  writeFileSync(join(out, 'pyric-0.1.0-alpha.8.tgz'), 'an older pack');
  writeFileSync(join(out, 'proven.json'), '{}');
  writeFileSync(join(out, 'notes.txt'), 'not the pack\'s');
  return out;
}

/** npm pack as a stub: a tarball holding the package's manifest, named the way npm names it. */
const NPM_PACK = `if [ "$1" = pack ]; then
  dest="$4"; name=$(jq -r .name package.json); version=$(jq -r .version package.json)
  file="$(printf '%s' "\${name#@}" | tr / -)-\${version}.tgz"
  tmp=$(mktemp -d); mkdir -p "$tmp/package"; cp package.json "$tmp/package/"
  tar -czf "$dest/$file" -C "$tmp" package; echo "$file"; exit 0
fi
echo "npm stub: unexpected npm $*" >&2; exit 64`;

describe('a pack that fails leaves no tarball behind', () => {
  test('a failed build removes the older pack and its stamp, and keeps other files', () => {
    const out = staleOutDir();
    const run = runPack(out, { bash: 'exit 17' });
    expect(run.status).not.toBe(0);
    expect(readdirSync(out).sort()).toEqual(['notes.txt']);
  });

  test('a tarball that fails its own check is removed, with every tarball already packed', () => {
    const out = staleOutDir();
    const run = runPack(out, {
      npm: NPM_PACK,
      node: `if [[ "$1" == *verify-published-sourcemaps.mjs ]] && grep -q '"name": "pyric-admin"' "$2/package.json"; then echo "broken source map" >&2; exit 3; fi\nexec ${REAL_NODE} "$@"`,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('broken source map');
    expect(readdirSync(out).sort()).toEqual(['notes.txt']);
  });
});

/**
 * publish-alpha.sh with the real node (check-publish-version and
 * proven-stamp), in a scratch git repo holding copies of the scripts, with
 * npm, bun and bash stubbed. The bash stub packs the way pack-packages.sh
 * does: five tarballs, a manifest, and a real `proven-stamp.mjs record`.
 */
function realStampRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'pyric-publish-real-stamp-'));
  workDirs.push(repo);
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q');
  for (const path of ['scripts/publish-alpha.sh', 'scripts/lib/check-publish-version.mjs', 'scripts/lib/proven-stamp.mjs']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), readFileSync(join(root, path)));
  }
  for (const [dir, name] of [['pyric', 'pyric'], ['pyric-admin', 'pyric-admin'], ['create-pyric', 'create-pyric'], ['cli', '@pyric/cli'], ['ui', '@pyric/ui']]) {
    mkdirSync(join(repo, 'packages', dir ?? ''), { recursive: true });
    writeFileSync(join(repo, 'packages', dir ?? '', 'package.json'), JSON.stringify({ name, version: '0.1.0-alpha.9' }));
  }
  writeFileSync(join(repo, '.gitignore'), 'dist/\nbin/\ncommands.log\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'release');
  return repo;
}

function publishForReal(repo: string, env: Record<string, string> = {}) {
  const bin = join(repo, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(repo, 'commands.log');
  const packages = join(repo, 'dist/packages');
  const realNode = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
  const stubs: Record<string, string> = {
    npm: `echo "npm $*" >> "${log}"
if [ "$1" = publish ]; then
  echo "uploaded $(basename "$2") $(cat "$2")" >> "${log}"
  if [ "\${RACE:-}" = 1 ]; then echo "swapped after the check" > "${packages}/pyric-cli-0.1.0-alpha.9.tgz"; fi
fi`,
    bun: `echo "bun $*" >> "${log}"
if [ "\${MIDGATE:-}" = 1 ] && [ "$1" = test/apps/run.ts ]; then echo "a concurrent repack" > "${packages}/pyric-cli-0.1.0-alpha.9.tgz"; fi
if [ "\${TESTS_FAIL:-}" = 1 ] && [ "$*" = "run test" ]; then exit 1; fi`,
    bash: `echo "bash $*" >> "${log}"
if [ "$1" = scripts/pack-packages.sh ]; then
  mkdir -p "${packages}"; rm -f "${packages}"/*.tgz "${packages}"/*.json
  for n in pyric pyric-admin create-pyric pyric-cli pyric-ui; do echo "packed $n" > "${packages}/$n-0.1.0-alpha.9.tgz"; done
  echo '{"packages":[]}' > "${packages}/manifest.json"
  ${realNode} "${repo}/scripts/lib/proven-stamp.mjs" record "${packages}" "${repo}" "$(git -C "${repo}" rev-parse HEAD)" true
fi`,
  };
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(log, '');
  const result = spawnSync('/bin/bash', [join(repo, 'scripts/publish-alpha.sh'), '--dry-run', '0.1.0-alpha.9'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}`, PYRIC_PUBLISH_TAG: 'exp' },
  });
  const uploads = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('uploaded '));
  return { result, uploads };
}

const PACKED_UPLOADS = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui'].map((name) => `uploaded ${name}-0.1.0-alpha.9.tgz packed ${name}`);

describe('the stamp, with the real node, inside publish-alpha.sh', () => {
  test('a run whose gates pass uploads the five packed tarballs', () => {
    const { result, uploads } = publishForReal(realStampRepo());
    expect(result.status).toBe(0);
    expect(uploads).toEqual(PACKED_UPLOADS);
  });

  test('a tarball something swapped during the gates is not stamped, and nothing uploads', () => {
    const { result, uploads } = publishForReal(realStampRepo(), { MIDGATE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pyric-cli-0.1.0-alpha.9.tgz is not the file the pack names');
    expect(uploads).toEqual([]);
  });

  test('a tarball swapped in dist/packages after the last check does not change what uploads', () => {
    const { result, uploads } = publishForReal(realStampRepo(), { RACE: '1' });
    expect(result.status).toBe(0);
    expect(uploads).toEqual(PACKED_UPLOADS);
  });

  test('after a run whose tests fail, a gate-skipping rerun finds no stamp and uploads nothing', () => {
    const repo = realStampRepo();
    expect(publishForReal(repo).result.status).toBe(0);
    expect(publishForReal(repo, { TESTS_FAIL: '1' }).result.status).toBe(1);
    const rerun = publishForReal(repo, { PYRIC_PUBLISH_SKIP_GATES: '1' });
    expect(rerun.result.status).toBe(1);
    expect(rerun.result.stderr).toContain('no gate run proved these tarballs');
    expect(rerun.uploads).toEqual([]);
  });
});

describe('an interrupted pack leaves no tarball behind', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`${signal} during the build clears the older pack and its stamp`, async () => {
      const out = staleOutDir();
      const work = mkdtempSync(join(tmpdir(), 'pyric-pack-signal-'));
      workDirs.push(work);
      const bin = join(work, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'bash'), '#!/bin/bash\nexec sleep 30\n');
      chmodSync(join(bin, 'bash'), 0o755);
      // Its own process group, as a shell gives a command; the signal goes to the group.
      const pack = spawn('/bin/bash', [join(root, 'scripts/pack-packages.sh'), '--out', out], {
        cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      process.kill(-(pack.pid ?? 0), signal);
      const code = await new Promise<number | null>((resolve) => pack.once('close', (exitCode) => resolve(exitCode)));
      expect(code).not.toBe(0);
      expect(readdirSync(out).sort()).toEqual(['notes.txt']);
    }, 15_000);
  }
});
