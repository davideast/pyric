import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));
const node = process.env.PYRIC_TEST_NODE ?? 'node';

function runSandbox(directory: string, flags: string[] = []): string {
  const result = spawnSync(node, [
    cli, 'sandbox', '--no-open', '--no-watch', '--no-capture',
    '--port', '0', ...flags, node, '-e', 'process.exit(0)',
  ], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(0);
  return output;
}

function seedProject(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-hosted-launcher-')));
  writeFileSync(join(directory, 'seed.json'), JSON.stringify({
    version: 1,
    firestore: { version: 1, savedAt: 0, firestore: { 'notes/one': { title: 'Seeded note' } } },
    auth: { users: [{ uid: 'reader', email: 'reader@example.test' }] },
  }));
  return directory;
}

test('hosted first start reports the applied seed counts; restart reports restored state', () => {
  const directory = seedProject();
  try {
    const first = runSandbox(directory, ['--hosted', '--seed', 'seed.json']);
    expect(first).toContain('1 doc(s), 1 user(s)');
    expect(first).toContain('--seed applied');
    expect(first).not.toContain('--seed skipped');

    const restart = runSandbox(directory, ['--hosted', '--seed', 'seed.json']);
    expect(restart).toContain('1 doc(s), 1 user(s) restored; --seed skipped');
    expect(restart).not.toContain('--seed applied');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('hosted fresh explains how to restore its archived directory', () => {
  const directory = seedProject();
  try {
    runSandbox(directory, ['--hosted', '--seed', 'seed.json']);
    const fresh = runSandbox(directory, ['--hosted', '--fresh']);
    expect(fresh).toContain(`a recovery backup exists at ${join(directory, '.pyric', 'state', 'hosted.archive-')}`);
    expect(fresh).toContain('stop the host');
    expect(fresh).toContain('rename');
    expect(fresh).toContain('.pyric/state/hosted');
    expect(fresh).not.toContain('mv it back over state.json');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('only browser mode asks a child-command user to open a page to connect the sandbox', () => {
  const directory = seedProject();
  try {
    const browser = runSandbox(directory);
    expect(browser).toMatch(
      /Auto-open is disabled \(--no-open\/CI\)\. The pyric sandbox is browser-resident: open http:\/\/localhost:\d+ to connect if your command performs Firebase operations\./,
    );

    const hosted = runSandbox(directory, ['--hosted']);
    expect(hosted).not.toContain('The pyric sandbox is browser-resident:');
    expect(hosted).toContain('the pyric sandbox executes in this Node process.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
