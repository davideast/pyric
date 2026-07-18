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

function runPublish(options: { skip?: boolean; dryRun?: boolean; failBunCommand?: string } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'pyric-publish-contract-'));
  workDirs.push(work);
  const bin = join(work, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  const log = join(work, 'commands.log');
  const fake = `#!/bin/bash
set -eu
name="$(basename "$0")"
echo "$name $*" >> "$COMMAND_LOG"
if [ "$name $*" = "bun run packages/conformance/src/print-fb-tag.ts" ]; then echo fb12.13; fi
if [ -n "\${FAIL_BUN_COMMAND:-}" ] && [ "$name $*" = "bun $FAIL_BUN_COMMAND" ]; then exit 17; fi
`;
  for (const command of ['node', 'bun', 'npm', 'bash']) {
    const path = join(bin, command);
    writeFileSync(path, fake);
    chmodSync(path, 0o755);
  }
  const args = [join(root, 'scripts/publish-alpha.sh')];
  if (options.dryRun) args.push('--dry-run');
  args.push('0.1.0-alpha.9');
  const result = spawnSync('/bin/bash', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COMMAND_LOG: log,
      FAIL_BUN_COMMAND: options.failBunCommand ?? '',
      PYRIC_PUBLISH_SKIP_GATES: options.skip ? '1' : '0',
    },
  });
  return { result, commands: readFileSync(log, 'utf8').trim().split('\n') };
}

describe('alpha publish safety contract', () => {
  test('proves the tree before the first irreversible publish', () => {
    const { result, commands } = runPublish();
    expect(result.status).toBe(0);
    const tests = commands.indexOf('bun run test');
    const packaging = commands.indexOf('bun run test:packaging');
    const pack = commands.indexOf('bash scripts/pack-packages.sh');
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(tests).toBeLessThan(packaging);
    expect(packaging).toBeLessThan(pack);
    expect(pack).toBeLessThan(publish);
  });

  test('a failed proof prevents every publish', () => {
    const { result, commands } = runPublish({ failBunCommand: 'run test:packaging' });
    expect(result.status).toBe(17);
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });

  test('the explicit rerun escape hatch skips only the proofs', () => {
    const { result, commands } = runPublish({ skip: true });
    expect(result.status).toBe(0);
    expect(commands).not.toContain('bun run test');
    expect(commands).not.toContain('bun run test:packaging');
    expect(commands).toContain('bash scripts/pack-packages.sh');
    expect(commands.filter((command) => command.startsWith('npm publish '))).toHaveLength(5);
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
});
