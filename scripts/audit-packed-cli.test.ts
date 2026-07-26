import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '..');
const workDirs: string[] = [];

afterEach(() => {
  for (const directory of workDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runAudit(edges: Record<string, string>, allowedFirebaseSdkImportEdges: string[]) {
  const work = mkdtempSync(join(tmpdir(), 'pyric-packed-cli-audit-'));
  workDirs.push(work);
  const packageDir = join(work, 'consumer/node_modules/@pyric/cli');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@pyric/cli', version: '0.0.0', exports: {} }),
  );
  for (const [file, source] of Object.entries(edges)) {
    const path = join(packageDir, file);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
  const contractPath = join(work, 'release-contract.json');
  writeFileSync(
    contractPath,
    JSON.stringify({ exports: [], allowedFirebaseSdkImportEdges }),
  );
  return spawnSync(
    process.execPath,
    [
      join(root, 'scripts/audit-packed-cli.mjs'),
      join(work, 'consumer'),
      contractPath,
    ],
    { encoding: 'utf8' },
  );
}

describe('packed CLI Firebase SDK edge contract', () => {
  test('accepts only an explicitly pinned consumer-supplied Firebase bridge', () => {
    const result = runAudit(
      { 'dist/register/app-bridge.js': "import * as realApp from 'firebase/app';\n" },
      ['dist/register/app-bridge.js -> firebase/app'],
    );

    expect(result.status).toBe(0);
  });

  test('rejects an additional Firebase SDK import edge', () => {
    const result = runAudit(
      {
        'dist/register/app-bridge.js': "import * as realApp from 'firebase/app';\n",
        'dist/accidental.js': "import { getAuth } from 'firebase/auth';\n",
      },
      ['dist/register/app-bridge.js -> firebase/app'],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/accidental.js -> firebase/auth');
  });
});
