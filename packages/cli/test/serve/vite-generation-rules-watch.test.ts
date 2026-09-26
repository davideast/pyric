import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ViteDevServer } from 'vite';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { watchViteGenerationRules } from '../../src/serve/vite-generation-rules-watch.js';

const MAIN = '/project/firestore.modules.rules';
const GAME = '/project/games/tictactoe.rules';
const SHARED = '/project/games/shared.rules';

function fakes(files: { current: string[] }) {
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
    reloadFirestoreRules: async () => {
      reloads += 1;
      return { kind: 'reloaded', rulesHash: 'h', clients: 1 };
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
    expect([...f.watched].sort()).toEqual([GAME, MAIN, SHARED].sort());

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

  test('ignores a change to a file the rules do not import', async () => {
    const f = fakes({ current: [GAME] });
    const stop = watchViteGenerationRules({ server: f.server, session: f.session });
    f.watcher.emit('change', '/project/src/main.ts');
    await settle();
    expect(f.reloads()).toBe(0);
    stop?.();
  });
});
