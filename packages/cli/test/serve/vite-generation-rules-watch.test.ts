import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ViteDevServer } from 'vite';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { watchViteGenerationRules } from '../../src/serve/vite-generation-rules-watch.js';

const MAIN = '/project/firestore.modules.rules';
const GAME = '/project/games/tictactoe.rules';
const SHARED = '/project/games/shared.rules';

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
    databaseRulesFile: () => '/project/database.rules.json',
    reloadFirestoreRules: async () => {
      reloads += 1;
      const kind = results.shift() ?? 'reloaded';
      if (kind === 'rejected') return { kind, error: new Error('module resolution failed') };
      return { kind, rulesHash: 'h', clients: 1 };
    },
    reloadDatabaseRules: async () => ({ kind: 'not-configured' }),
  } as unknown as SandboxSession;
  return { server, session, watcher, watched, reloads: () => reloads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('Vite rules watching', () => {
  test('watches the module files the rules import, and reloads when one changes', async () => {
    const files = { current: [GAME, SHARED] };
    const f = fakes(files);
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    expect([...f.watched].sort()).toEqual([GAME, MAIN, SHARED, '/project/database.rules.json'].sort());

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
    databaseRulesFile: () => DATABASE,
    reloadFirestoreRules: async () => {
      firestoreReloads += 1;
      return { kind: 'reloaded', rulesHash: 'fh', clients: 1 };
    },
    reloadDatabaseRules: async () => {
      databaseReloads += 1;
      return databaseResults.shift() ?? { kind: 'not-configured' };
    },
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
    expect(f.logs.some((line) => line.includes('rtdb rules reloaded (dh)'))).toBe(true);
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
