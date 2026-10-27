import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  for (const command of ['node', 'bun', 'npm', 'bash']) {
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

  test('every publish uploads a tarball the pack wrote, the ones the gates tested', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const uploads = commands.filter((command) => command.startsWith('npm publish ')).map((command) => command.split(' ')[2]);
    expect(uploads).toEqual(['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui'].map((name) => `dist/packages/${name}-0.1.0-alpha.9.tgz`));
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
