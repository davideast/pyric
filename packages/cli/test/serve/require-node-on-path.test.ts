import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  MISSING_NODE_ON_PATH_MESSAGE,
  resolveNodeExecutable,
} from './require-node-on-path.js';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('resolveNodeExecutable (#1854)', () => {
  it('fails immediately and names node when PATH has no node executable', () => {
    const bunOnlyDir = makeTempDir('pyric-bun-only-path-');
    symlinkSync(process.execPath, join(bunOnlyDir, 'bun'));

    expect(() => resolveNodeExecutable({ PATH: bunOnlyDir }, 'linux')).toThrow(
      MISSING_NODE_ON_PATH_MESSAGE,
    );
    expect(() => resolveNodeExecutable({ PATH: '' }, 'linux')).toThrow(
      MISSING_NODE_ON_PATH_MESSAGE,
    );
  });

  it('resolves node on PATH or explicit PYRIC_TEST_NODE and rejects missing PYRIC_TEST_NODE', () => {
    const binDir = makeTempDir('pyric-fake-node-bin-');
    mkdirSync(binDir, { recursive: true });
    const fakeNode = join(binDir, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeNode, 0o755);

    expect(resolveNodeExecutable({ PATH: `${ delimiter }${binDir}` }, 'linux')).toBe(fakeNode);
    expect(
      resolveNodeExecutable({ PATH: '', PYRIC_TEST_NODE: fakeNode }, 'linux'),
    ).toBe(fakeNode);

    expect(() =>
      resolveNodeExecutable({ PATH: '', PYRIC_TEST_NODE: join(binDir, 'missing-node') }, 'linux'),
    ).toThrow('PYRIC_TEST_NODE');
  });

  it('fails Node host, Functions, and Vite restart fixtures immediately with one clear message when node is missing from PATH', () => {
    const bunOnlyDir = makeTempDir('pyric-bun-subproc-path-');
    symlinkSync(process.execPath, join(bunOnlyDir, 'bun'));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: bunOnlyDir,
    };
    delete env.PYRIC_TEST_NODE;

    const suites: Array<{ file: string; filter: string }> = [
      {
        file: 'test/serve/hosted-sqlite-storage-chunked.test.ts',
        filter: 'Storage stages chunked uploads',
      },
      {
        file: 'test/serve/vite-plugin-functions.test.ts',
        filter: 'discovers a functions codebase',
      },
      {
        file: 'test/serve/vite-plugin-restart.test.ts',
        filter: 'persisting browser state restarts',
      },
    ];

    for (const suite of suites) {
      const started = Date.now();
      const run = spawnSync(
        process.execPath,
        ['test', suite.file, '--test-name-pattern', suite.filter],
        {
          cwd: CLI_ROOT,
          encoding: 'utf8',
          env,
          timeout: 15_000,
        },
      );
      const elapsedMs = Date.now() - started;
      const combined = `${run.stdout}\n${run.stderr}`;
      expect(run.status).not.toBe(0);
      expect(elapsedMs).toBeLessThan(10_000);
      expect(combined).toContain(MISSING_NODE_ON_PATH_MESSAGE);
      expect(combined).not.toContain('Node fixture failed (undefined)');
      expect(combined).not.toContain('timed out waiting for the plugin Functions outcome');
      expect(combined).not.toContain('Vite restart host failed');
    }
  }, 30_000);
});
