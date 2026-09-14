import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = resolve('scripts/test-isolated.ts');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-isolated-tests-'));
  directories.push(directory);
  return directory;
}

test('isolated test command gives each requested file a fresh global realm', () => {
  const directory = fixtureDirectory();
  const first = join(directory, 'first file.test.ts');
  const second = join(directory, 'second file.test.ts');
  const source = `
    import { expect, test } from 'bun:test';
    test('starts with a fresh global realm', () => {
      expect('isolatedFixture' in globalThis).toBe(false);
      Object.defineProperty(globalThis, 'isolatedFixture', { value: true });
    });
  `;
  writeFileSync(first, source);
  writeFileSync(second, source);

  const result = spawnSync(process.execPath, [runner, first, second], { encoding: 'utf8' });

  expect(result.stderr).not.toContain('(fail)');
  expect(result.status).toBe(0);
  expect(result.stderr.match(/ 1 pass/g)).toHaveLength(2);
});

test('isolated test command refuses an empty file list', () => {
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage: bun scripts/test-isolated.ts <test-file>...');
});

test('isolated test command refuses a run that skips a requested test', () => {
  const directory = fixtureDirectory();
  const file = join(directory, 'incomplete.test.ts');
  writeFileSync(file, `
    import { test } from 'bun:test';
    test('executes one scenario', () => {});
    test.skip('required scenario is not executed', () => {});
  `);

  const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8' });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Skipped or unfinished tests cannot pass the isolated baseline');
});

test('isolated test command stops after a failing file', () => {
  const directory = fixtureDirectory();
  const failing = join(directory, 'failing.test.ts');
  const later = join(directory, 'later.test.ts');
  writeFileSync(failing, `
    import { test } from 'bun:test';
    test('fails deliberately', () => { throw new Error('fixture failure'); });
  `);
  writeFileSync(later, `
    import { test } from 'bun:test';
    test('must not run', () => console.log('LATER_FILE_EXECUTED'));
  `);

  const result = spawnSync(process.execPath, [runner, failing, later], { encoding: 'utf8' });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('fixture failure');
  expect(result.stdout).not.toContain('LATER_FILE_EXECUTED');
});

test('isolated test command refuses unfinished scenarios', () => {
  const directory = fixtureDirectory();
  const file = join(directory, 'unfinished.test.ts');
  writeFileSync(file, `
    import { test } from 'bun:test';
    test('executes one scenario', () => {});
    test.todo('required scenario remains unfinished');
  `);

  const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8' });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Skipped or unfinished tests cannot pass the isolated baseline');
});
