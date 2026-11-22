import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { formatPyricCommand, resolvePyricCommandPrefix } from '../../src/cli/command-hint.js';
import { runDatabaseRulesGenerate } from '../../src/cli/database-rules.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';
import { runSnapshot } from '../../src/cli/snapshot.js';
import { createStateStore } from '../../src/serve/state-store.js';
import { createVerifyHint } from '../../src/serve/verify-hint.js';

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

function writeExecutablePyricStub(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, process.platform === 'win32' ? 'pyric.cmd' : 'pyric');
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

describe('resolvePyricCommandPrefix and formatPyricCommand (#1201)', () => {
  it('returns npx pyric when executed from a local node_modules install even when node_modules/.bin is on PATH', () => {
    const projectDir = makeTempDir('pyric-hint-local-');
    const localBin = join(projectDir, 'node_modules', '.bin');
    writeExecutablePyricStub(localBin);
    const localEntry = join(projectDir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');

    const prefix = resolvePyricCommandPrefix({
      moduleFilePath: localEntry,
      pathEnv: `${localBin}${delimiter}/usr/bin`,
      embedded: false,
    });

    expect(prefix).toBe('npx pyric');
    expect(
      formatPyricCommand('sandbox --seed pyric-state', {
        moduleFilePath: localEntry,
        pathEnv: `${localBin}${delimiter}/usr/bin`,
        embedded: false,
      }),
    ).toBe('npx pyric sandbox --seed pyric-state');
  });

  it('returns npx pyric when pyric is only on PATH via node_modules/.bin', () => {
    const projectDir = makeTempDir('pyric-hint-nm-bin-');
    const localBin = join(projectDir, 'node_modules', '.bin');
    writeExecutablePyricStub(localBin);

    const prefix = resolvePyricCommandPrefix({
      moduleFilePath: '/workspace/packages/cli/src/cli/index.ts',
      pathEnv: localBin,
      embedded: false,
    });
    expect(prefix).toBe('npx pyric');
  });

  it('returns bare pyric for standalone embedded binaries or real global PATH installs', () => {
    expect(
      resolvePyricCommandPrefix({
        moduleFilePath: '/usr/local/bin/pyric',
        pathEnv: '',
        embedded: true,
      }),
    ).toBe('pyric');

    const globalBin = makeTempDir('pyric-hint-global-bin-');
    writeExecutablePyricStub(globalBin);
    expect(
      resolvePyricCommandPrefix({
        moduleFilePath: join(globalBin, 'pyric'),
        pathEnv: globalBin,
        embedded: false,
      }),
    ).toBe('pyric');
  });
});

describe('CLI hint emitters print runnable commands for local installs (#1201)', () => {
  it('prints npx pyric in snapshot, database rules generate, and verify-hint when no global pyric is on PATH', async () => {
    const previousPath = process.env.PATH;
    const emptyBin = makeTempDir('pyric-empty-bin-');
    process.env.PATH = emptyBin;

    try {
      const cwd = makeTempDir('pyric-local-hints-');
      writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
      mkdirSync(join(cwd, 'public'), { recursive: true });
      writeFileSync(join(cwd, 'public', 'index.html'), '<!doctype html><html><body></body></html>');

      // 1. Empty snapshot hint
      let emptyStderr = '';
      const emptyExit = await runSnapshot(
        { subcommand: 'snapshot', flags: new Map(), positional: [] },
        {
          cwd,
          stdout: { write: () => true },
          stderr: { write: (s: string) => void (emptyStderr += s) },
          fetchLive: async () => null,
        },
      );
      expect(emptyExit).toBe(2);
      expect(emptyStderr).toContain('npx pyric sandbox --persist');

      // 2. Promoted snapshot hint
      createStateStore(cwd).writeSection('firestore', {
        version: 1,
        savedAt: 1,
        firestore: { 'posts/p1': { title: 'hi' } },
      });
      let snapStdout = '';
      const snapExit = await runSnapshot(
        { subcommand: 'snapshot', flags: new Map(), positional: [] },
        {
          cwd,
          stdout: { write: (s: string) => void (snapStdout += s) },
          stderr: { write: () => true },
          fetchLive: async () => null,
        },
      );
      expect(snapExit).toBe(0);
      expect(snapStdout).toContain('Re-serve it: npx pyric sandbox --seed pyric-state');

      // 3. Database rules generate hint
      let dbStdout = '';
      const dbExit = await runDatabaseRulesGenerate(
        {
          positional: [],
          flags: new Map<string, string | boolean>([['out', 'database.rules.json']]),
        } as unknown as ParsedArgs,
        {
          cwd,
          stdout: { write: (s: string) => ((dbStdout += s), true) } as NodeJS.WriteStream,
          stderr: { write: () => true } as NodeJS.WriteStream,
          loadRulesDocument: async () => ({
            ok: true,
            document: { toJSON: () => ({ rules: { '.read': true } }) } as never,
          }),
          mkdir: (async () => undefined) as never,
          writeFile: (async () => undefined) as never,
        },
      );
      expect(dbExit).toBe(0);
      expect(dbStdout).toContain(
        'Test before deploy: npx pyric verify --service rtdb --rules rtdb=database.rules.json',
      );

      // 4. Verify hint on reload after capture
      const capturePath = join(cwd, '.pyric', 'last-session.json');
      mkdirSync(join(cwd, '.pyric'), { recursive: true });
      writeFileSync(
        capturePath,
        JSON.stringify({
          schemaVersion: 1,
          events: [{ service: 'firestore', op: 'get', path: 'posts/p1', allowed: true }],
        }),
      );
      const hint = createVerifyHint({ capturePath });
      expect(hint('firestore')).toBe(
        ' (run `npx pyric verify` to replay the captured session against these rules)',
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});
