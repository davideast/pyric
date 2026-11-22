import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { formatPyricCommand } from '../../src/cli/command-hint.js';
import { recordGeneratedRulesWrite } from '../../src/serve/verify-hint.js';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { watchViteGenerationRules } from '../../src/serve/vite-generation-rules-watch.js';

const MAIN = '/project/firestore.modules.rules';
const GAME = '/project/games/tictactoe.rules';
const SHARED = '/project/games/shared.rules';
const STORAGE = '/project/storage.rules';

type ReloadKind = 'reloaded' | 'rejected';

function fakes(files: { current: string[] }, results: ReloadKind[] = []) {
  const watched = new Set<string>();
  const watcher = Object.assign(new EventEmitter(), {
    add(paths: string | readonly string[]) {
      for (const p of typeof paths === 'string' ? [paths] : paths) watched.add(p);
      return watcher;
    },
  });
  const logs: string[] = [];
  const server = {
    watcher,
    config: { logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } },
  } as unknown as ViteDevServer;
  let reloads = 0;
  const session = {
    summary: { rules: { firestore: { sourcePath: MAIN }, database: { sourcePath: null } } },
    firestoreRulesFiles: () => [MAIN, ...files.current],
    databaseRulesFiles: () => ['/project/database.rules.json'],
    storageRulesFiles: () => [STORAGE],
    reloadFirestoreRules: async () => {
      reloads += 1;
      const kind = results.shift() ?? 'reloaded';
      if (kind === 'rejected') return { kind, error: new Error('module resolution failed') };
      return { kind, rulesHash: 'h', clients: 1 };
    },
    reloadDatabaseRules: async () => [],
    reloadStorageRules: async () => [],
  } as unknown as SandboxSession;
  return { server, session, watcher, watched, reloads: () => reloads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('Vite rules watching', () => {
  test('watches the module files the rules import, and reloads when one changes', async () => {
    const files = { current: [GAME, SHARED] };
    const f = fakes(files);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect([...f.watched].sort()).toEqual([GAME, MAIN, SHARED, '/project/database.rules.json', STORAGE].sort());

    f.watcher.emit('change', SHARED);
    await settle();
    expect(f.reloads()).toBe(1);
    stop?.();
  });

  test('starts watching a module file the rules import after a reload', async () => {
    const files = { current: [GAME] };
    const f = fakes(files);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(f.watched.has(SHARED)).toBe(false);

    files.current = [GAME, SHARED];
    f.watcher.emit('change', GAME);
    await settle();
    expect(f.watched.has(SHARED)).toBe(true);

    f.watcher.emit('change', SHARED);
    await settle();
    expect(f.reloads()).toBe(2);
    stop?.();
  });

  test('watches a module file a rejected reload imports, and reloads when it is fixed', async () => {
    const files = { current: [GAME] };
    const f = fakes(files, ['rejected']);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });

    files.current = [GAME, SHARED];
    f.watcher.emit('change', MAIN);
    await settle();
    expect(f.reloads()).toBe(1);
    expect(f.watched.has(SHARED)).toBe(true);

    f.watcher.emit('change', SHARED);
    await settle();
    expect(f.reloads()).toBe(2);
    stop?.();
  });

  test('reloads when a module file the rules import is created', async () => {
    const f = fakes({ current: [GAME, SHARED] });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('add', SHARED);
    await settle();
    expect(f.reloads()).toBe(1);
    stop?.();
  });

  test('ignores a change to a file the rules do not import', async () => {
    const f = fakes({ current: [GAME] });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('change', '/project/src/main.ts');
    await settle();
    expect(f.reloads()).toBe(0);
    stop?.();
  });
});

const FIRESTORE = '/project/firestore.rules';
const DATABASE = '/project/database.rules.json';

type DatabaseResult =
  | { kind: 'reloaded'; rulesHash: string; clients: number }
  | { kind: 'removed'; policy: 'allow' | 'deny'; clients: number }
  | { kind: 'not-configured' };

/** A session started with no rules files: the paths the rules would load from
 *  are known, and nothing was loaded from them. */
function missingFilesFakes(databaseResults: DatabaseResult[]) {
  const f = fakes({ current: [] });
  const logs: string[] = [];
  (f.server.config as unknown as { logger: unknown }).logger = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
  };
  let firestoreReloads = 0;
  let databaseReloads = 0;
  const session = {
    summary: { rules: { firestore: { sourcePath: null }, database: { sourcePath: null } } },
    firestoreRulesFiles: () => [FIRESTORE],
    databaseRulesFiles: () => [DATABASE],
    storageRulesFiles: () => [STORAGE],
    reloadFirestoreRules: async () => {
      firestoreReloads += 1;
      return { kind: 'reloaded', rulesHash: 'fh', clients: 1 };
    },
    reloadDatabaseRules: async (file: string) => {
      databaseReloads += 1;
      return [{ instance: 'demo-default-rtdb', file, result: databaseResults.shift() ?? { kind: 'not-configured' } }];
    },
    reloadStorageRules: async () => [],
  } as unknown as SandboxSession;
  return {
    ...f,
    session,
    logs,
    firestoreReloads: () => firestoreReloads,
    databaseReloads: () => databaseReloads,
  };
}

describe('Vite rules watching when a rules file does not exist at startup', () => {
  test('watches the paths the rules would load from', () => {
    const f = missingFilesFakes([]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(stop).not.toBeNull();
    expect(f.watched.has(FIRESTORE)).toBe(true);
    expect(f.watched.has(DATABASE)).toBe(true);
    stop?.();
  });

  test('loads database rules created after startup', async () => {
    const f = missingFilesFakes([{ kind: 'reloaded', rulesHash: 'dh', clients: 1 }]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('add', DATABASE);
    await settle();
    expect(f.databaseReloads()).toBe(1);
    expect(f.logs.some((line) => line.includes('rtdb rules reloaded for demo-default-rtdb (dh)'))).toBe(true);
    stop?.();
  });

  test('returns RTDB to deny-all with a notice when the database rules file is deleted', async () => {
    const f = missingFilesFakes([
      { kind: 'reloaded', rulesHash: 'dh', clients: 1 },
      { kind: 'removed', policy: 'deny', clients: 1 },
    ]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('add', DATABASE);
    await settle();
    f.watcher.emit('unlink', DATABASE);
    await settle();
    expect(f.databaseReloads()).toBe(2);
    const notice = f.logs.find((line) => line.includes('rtdb rules removed'));
    expect(notice).toBeDefined();
    expect(notice).toContain(DATABASE);
    expect(notice).toContain('DENY');
    stop?.();
  });

  test('loads Firestore rules created after startup', async () => {
    const f = missingFilesFakes([]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('add', FIRESTORE);
    await settle();
    expect(f.firestoreReloads()).toBe(1);
    expect(f.logs.some((line) => line.includes('rules reloaded (fh)'))).toBe(true);
    stop?.();
  });

  test('reloads Firestore rules when the rules file is deleted', async () => {
    const f = missingFilesFakes([]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('unlink', FIRESTORE);
    await settle();
    expect(f.firestoreReloads()).toBe(1);
    stop?.();
  });
});

type StorageResult =
  | { kind: 'reloaded'; rulesHash: string; clients: number }
  | { kind: 'rejected'; error: Error }
  | { kind: 'removed'; policy: 'allow' | 'deny'; clients: number }
  | { kind: 'not-configured' };

/** A session whose Storage rules reload answers with `results` in order. */
function storageFakes(results: StorageResult[]) {
  const f = missingFilesFakes([]);
  let storageReloads = 0;
  const session = {
    ...f.session,
    reloadStorageRules: async (file: string) => {
      storageReloads += 1;
      return [{ bucket: null, file, result: results.shift() ?? { kind: 'not-configured' } }];
    },
  } as unknown as SandboxSession;
  return { ...f, session, storageReloads: () => storageReloads };
}

describe('Vite Storage rules watching', () => {
  test('watches the path the Storage rules load from', () => {
    const f = storageFakes([]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(f.watched.has(STORAGE)).toBe(true);
    stop();
  });

  test('loads Storage rules created after startup', async () => {
    const f = storageFakes([{ kind: 'reloaded', rulesHash: 'sh', clients: 1 }]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('add', STORAGE);
    await settle();
    expect(f.storageReloads()).toBe(1);
    expect(f.firestoreReloads()).toBe(0);
    expect(f.databaseReloads()).toBe(0);
    expect(f.logs.some((line) => line.includes('storage rules reloaded (sh)'))).toBe(true);
    stop();
  });

  test('reloads changed Storage rules, and keeps the last-good rules when a change does not parse', async () => {
    const f = storageFakes([
      { kind: 'reloaded', rulesHash: 'sh', clients: 1 },
      { kind: 'rejected', error: new Error('storage.rules failed to parse') },
    ]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('change', STORAGE);
    await settle();
    f.watcher.emit('change', STORAGE);
    await settle();
    expect(f.storageReloads()).toBe(2);
    const warning = f.logs.find((line) => line.includes('storage rules NOT reloaded'));
    expect(warning).toContain('last-good stays live');
    expect(warning).toContain('failed to parse');
    stop();
  });

  test('reloads every service whose file changed within one debounce window', async () => {
    const f = storageFakes([{ kind: 'reloaded', rulesHash: 'sh', clients: 1 }]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('change', FIRESTORE);
    f.watcher.emit('change', STORAGE);
    await settle();
    expect(f.firestoreReloads()).toBe(1);
    expect(f.storageReloads()).toBe(1);
    stop();
  });

  test('returns Storage to deny-all with a notice when the Storage rules file is deleted', async () => {
    const f = storageFakes([{ kind: 'removed', policy: 'deny', clients: 1 }]);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('unlink', STORAGE);
    await settle();
    expect(f.storageReloads()).toBe(1);
    const notice = f.logs.find((line) => line.includes('storage rules removed'));
    expect(notice).toContain(STORAGE);
    expect(notice).toContain('DENY');
    stop();
  });
});

describe('Vite rules watching on a live host', () => {
  async function reloadAll(live: boolean): Promise<string[]> {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-vite-live-vs-sandbox-'));
    try {
      const capturePath = join(tempDir, '.pyric', 'last-session.json');
      mkdirSync(join(tempDir, '.pyric'), { recursive: true });
      writeFileSync(
        capturePath,
        JSON.stringify({
          schemaVersion: 1,
          events: [{ service: 'firestore', op: 'get', path: 'items/a', allowed: true }],
        }),
      );
      const f = missingFilesFakes([{ kind: 'reloaded', rulesHash: 'dh', clients: 1 }]);
      Object.assign(f.session, {
        summary: { ...f.session.summary, capturePath },
        reloadStorageRules: async (file: string) => [
          { bucket: null, file, result: { kind: 'reloaded', rulesHash: 'sh', clients: 1 } },
        ],
      });
      const stop = watchViteGenerationRules({ server: f.server, session: f.session, live });
      f.watcher.emit('change', FIRESTORE);
      f.watcher.emit('change', DATABASE);
      f.watcher.emit('change', STORAGE);
      await settle();
      f.watcher.emit('change', FIRESTORE);
      await settle();
      stop();
      return f.logs.filter((line) => line.includes('reloaded'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  test('says each reload changed only the sandbox, with no verify hint', async () => {
    expect((await reloadAll(true)).sort()).toEqual([
      '  ↻ [pyric] rtdb rules reloaded for demo-default-rtdb (dh) for the sandbox. Production keeps its deployed rules.',
      '  ↻ [pyric] rules reloaded (fh) for the sandbox. Production keeps its deployed rules.',
      '  ↻ [pyric] rules reloaded (fh) for the sandbox. Production keeps its deployed rules.',
      '  ↻ [pyric] storage rules reloaded (sh) for the sandbox. Production keeps its deployed rules.',
    ].sort());
  });

  test('a sandbox host prints its verify hint once per service when a captured session exists', async () => {
    const lines = await reloadAll(false);
    const verifyCmd = formatPyricCommand('verify');
    expect(lines.filter((line) => line.includes(verifyCmd))).toHaveLength(3);
    expect(lines.some((line) => line.includes('Production keeps'))).toBe(false);
  });
});

describe('Vite rules watching with two database instances', () => {
  const A = '/project/a.rules.json';
  const B = '/project/b.rules.json';

  test('editing one instance file reloads only that file', async () => {
    const f = fakes({ current: [] });
    const reloaded: string[] = [];
    Object.assign(f.session, {
      databaseRulesFiles: () => [A, B],
      reloadDatabaseRules: async (file: string) => {
        reloaded.push(file);
        return [{ instance: file === A ? 'first' : 'second', file, result: { kind: 'reloaded', rulesHash: 'h', clients: 1 } }];
      },
    });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(f.watched.has(A)).toBe(true);
    expect(f.watched.has(B)).toBe(true);
    f.watcher.emit('change', B);
    await settle();
    expect(reloaded).toEqual([B]);
    f.watcher.emit('change', A);
    f.watcher.emit('change', B);
    await settle();
    expect(reloaded).toEqual([B, A, B]);
    stop?.();
  });
});

describe('Vite rules watching for Storage 2+modules imports', () => {
  const ST_HELPER = '/project/st-helper.rules';
  const ST_EXTRA = '/project/st-extra.rules';

  test('watches imported Storage module files, adds newly imported modules on reload, and reloads when one changes', async () => {
    const f = fakes({ current: [] });
    const storageModules = { current: [ST_HELPER] };
    const reloadedFiles: string[] = [];
    Object.assign(f.session, {
      storageRulesFiles: () => [STORAGE, ...storageModules.current],
      reloadStorageRules: async (file: string) => {
        reloadedFiles.push(file);
        return [{ bucket: null, file: STORAGE, result: { kind: 'reloaded', rulesHash: 'sh', clients: 1 } }];
      },
    });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(f.watched.has(ST_HELPER)).toBe(true);
    expect(f.watched.has(ST_EXTRA)).toBe(false);

    storageModules.current = [ST_HELPER, ST_EXTRA];
    f.watcher.emit('change', ST_HELPER);
    await settle();
    expect(reloadedFiles).toEqual([ST_HELPER]);
    expect(f.watched.has(ST_EXTRA)).toBe(true);

    f.watcher.emit('change', ST_EXTRA);
    await settle();
    expect(reloadedFiles).toEqual([ST_HELPER, ST_EXTRA]);
    stop?.();
  });
});

describe('Vite rules watching with named Firestore databases', () => {
  test('reloads only the changed database file and logs the named database suffix', async () => {
    const REPORTS = '/project/reports.rules';
    const f = missingFilesFakes([]);
    const reloadedFiles: string[] = [];
    Object.assign(f.session, {
      firestoreRulesFiles: () => [MAIN, REPORTS],
      reloadFirestoreDatabaseRules: async (file: string) => {
        reloadedFiles.push(file);
        return [
          {
            database: 'reports',
            file,
            result: { kind: 'reloaded' as const, rulesHash: 'rh', clients: 1 },
          },
        ];
      },
    });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect(f.watched.has(REPORTS)).toBe(true);

    f.watcher.emit('change', REPORTS);
    await settle();
    expect(reloadedFiles).toEqual([REPORTS]);
    expect(f.logs.some((line) => line.includes('rules reloaded for database "reports" (rh)'))).toBe(true);
    stop?.();
  });
});

describe('Vite rules watching verify hint (#1259)', () => {
  test('prints verify hint only when a captured session exists, once per service, and skips generated rules writes', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-vite-verify-hint-'));
    try {
      const fsFile = join(projectDir, 'firestore.rules');
      const dbFile = join(projectDir, 'database.rules.json');
      writeFileSync(fsFile, "rules_version = '2';");
      writeFileSync(dbFile, JSON.stringify({ rules: { '.read': false } }));

      const f = missingFilesFakes([
        { kind: 'reloaded', rulesHash: 'dbh1', clients: 1 },
        { kind: 'reloaded', rulesHash: 'dbh2', clients: 1 },
        { kind: 'reloaded', rulesHash: 'dbh3', clients: 1 },
        { kind: 'reloaded', rulesHash: 'dbh4', clients: 1 },
      ]);
      const capturePath = join(projectDir, '.pyric', 'last-session.json');
      Object.assign(f.session, {
        summary: {
          ...f.session.summary,
          capturePath,
        },
        firestoreRulesFiles: () => [fsFile],
        databaseRulesFiles: () => [dbFile],
      });

      const verifyText = `(run \`${formatPyricCommand('verify')}\` to replay the captured session against these rules)`;
      const stop = watchViteGenerationRules({
        server: f.server,
        session: f.session,
      });

      // 1. Reload before capture exists -> no verify hint, not spent.
      f.watcher.emit('change', dbFile);
      await settle();
      expect(f.logs.at(-1) ?? '').not.toContain('verify');

      // 2. Write non-empty capture, then simulate tool-generated write -> still not spent.
      mkdirSync(join(projectDir, '.pyric'), { recursive: true });
      writeFileSync(
        capturePath,
        JSON.stringify({
          schemaVersion: 1,
          events: [{ service: 'rtdb', op: 'get', path: '/items/a', allowed: true }],
        }),
      );
      const generatedContent = `${JSON.stringify({ rules: { '.read': 'auth != null' } }, null, 2)}\n`;
      recordGeneratedRulesWrite(projectDir, dbFile, generatedContent);
      writeFileSync(dbFile, generatedContent);
      f.watcher.emit('change', dbFile);
      await settle();
      expect(f.logs.at(-1) ?? '').not.toContain('verify');

      // 3. First user edit to database.rules.json -> prints verify hint!
      writeFileSync(
        dbFile,
        JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }),
      );
      f.watcher.emit('change', dbFile);
      await settle();
      expect(f.logs.at(-1) ?? '').toContain(verifyText);

      // 4. Second user edit to database.rules.json -> already spent for database.
      writeFileSync(dbFile, JSON.stringify({ rules: { '.read': true } }));
      f.watcher.emit('change', dbFile);
      await settle();
      expect(f.logs.at(-1) ?? '').not.toContain(verifyText);

      // 5. First user edit to firestore.rules -> prints once for Firestore!
      writeFileSync(fsFile, "rules_version = '2'; // user edit");
      f.watcher.emit('change', fsFile);
      await settle();
      expect(f.logs.at(-1) ?? '').toContain(verifyText);

      stop?.();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('suppresses verify hint across multiple RTDB instances and duplicate events sharing one generated database.rules.json, then prints on manual edit', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-vite-multi-inst-gen-'));
    try {
      const dbFile = join(projectDir, 'database.rules.json');
      writeFileSync(dbFile, JSON.stringify({ rules: { '.read': false } }));

      const f = missingFilesFakes([]);
      const capturePath = join(projectDir, '.pyric', 'last-session.json');
      mkdirSync(join(projectDir, '.pyric'), { recursive: true });
      writeFileSync(
        capturePath,
        JSON.stringify({
          schemaVersion: 1,
          events: [{ service: 'rtdb', op: 'get', path: '/items/a', allowed: true }],
        }),
      );

      let reloadCall = 0;
      Object.assign(f.session, {
        summary: { ...f.session.summary, capturePath },
        databaseRulesFiles: () => [dbFile],
        reloadDatabaseRules: async (file: string) => {
          reloadCall += 1;
          return [
            {
              instance: 'demo-default-rtdb',
              file,
              result: { kind: 'reloaded' as const, rulesHash: `h-def-${String(reloadCall)}`, clients: 1 },
            },
            {
              instance: 'demo-analytics-rtdb',
              file,
              result: { kind: 'reloaded' as const, rulesHash: `h-ana-${String(reloadCall)}`, clients: 1 },
            },
          ];
        },
      });

      const verifyText = `(run \`${formatPyricCommand('verify')}\` to replay the captured session against these rules)`;
      const stop = watchViteGenerationRules({
        server: f.server,
        session: f.session,
      });

      // Tool-generated write reloads TWO instances AND fires a duplicate watcher event with identical bytes.
      const generatedContent = `${JSON.stringify({ rules: { '.read': 'auth != null' } }, null, 2)}\n`;
      recordGeneratedRulesWrite(projectDir, dbFile, generatedContent);
      writeFileSync(dbFile, generatedContent);
      f.watcher.emit('change', dbFile);
      await settle();
      f.watcher.emit('change', dbFile);
      await settle();

      expect(f.logs.length).toBe(4);
      expect(f.logs.some((line) => line.includes('verify'))).toBe(false);

      // Manual edit changes content hash -> clears stamp and prints verify hint once!
      f.logs.length = 0;
      writeFileSync(
        dbFile,
        `${JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }, null, 2)}\n`,
      );
      f.watcher.emit('change', dbFile);
      await settle();

      expect(f.logs.length).toBe(2);
      expect(f.logs.filter((line) => line.includes(verifyText))).toHaveLength(1);

      stop?.();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
