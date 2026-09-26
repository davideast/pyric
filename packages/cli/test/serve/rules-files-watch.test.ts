import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchRulesFiles, type WatchFile } from '../../src/serve/rules-files-watch.js';

function fakeWatch() {
  const open = new Map<string, { fire: () => void; closed: boolean; emitter: EventEmitter }>();
  const watchFile: WatchFile = (file, listener) => {
    const emitter = new EventEmitter();
    const entry = { fire: listener, closed: false, emitter };
    open.set(file, entry);
    return {
      close: () => {
        entry.closed = true;
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
        return undefined as never;
      },
    } as ReturnType<WatchFile>;
  };
  return { open, watchFile };
}

describe('watching the rules source and its module files', () => {
  test('a change to any watched file reports that file', () => {
    const { open, watchFile } = fakeWatch();
    const changed: string[] = [];
    const watch = watchRulesFiles(() => ['/p/main.rules', '/p/games/a.rules'], (f) => changed.push(f), () => {}, watchFile);
    open.get('/p/games/a.rules')!.fire();
    expect(changed).toEqual(['/p/games/a.rules']);
    watch.close();
  });

  test('sync watches newly imported files and releases dropped ones', () => {
    const { open, watchFile } = fakeWatch();
    let files = ['/p/main.rules', '/p/games/a.rules'];
    const watch = watchRulesFiles(() => files, () => {}, () => {}, watchFile);
    files = ['/p/main.rules', '/p/games/b.rules'];
    watch.sync();
    expect(open.get('/p/games/a.rules')!.closed).toBe(true);
    expect(open.get('/p/games/b.rules')!.closed).toBe(false);
    expect(open.get('/p/main.rules')!.closed).toBe(false);
    watch.close();
    expect(open.get('/p/main.rules')!.closed).toBe(true);
  });

  test('a watcher error reaches onError instead of throwing', () => {
    const { open, watchFile } = fakeWatch();
    const errors: unknown[] = [];
    const watch = watchRulesFiles(() => ['/p/main.rules'], () => {}, (e) => errors.push(e), watchFile);
    open.get('/p/main.rules')!.emitter.emit('error', new Error('EMFILE'));
    expect(errors).toHaveLength(1);
    watch.close();
  });
});

describe('watching a module file that does not exist yet', () => {
  async function until(condition: () => boolean): Promise<void> {
    for (let waited = 0; waited < 3000 && !condition(); waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  test('creating the file reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-files-watch-'));
    const file = join(dir, 'b.rules');
    const changed: string[] = [];
    const errors: unknown[] = [];
    const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(e));
    writeFileSync(file, 'rules_version = \'2+modules\';');
    await until(() => changed.length > 0);
    watch.close();
    expect(errors).toEqual([]);
    expect(changed[0]).toBe(file);
  });

  test('creating the file inside a directory that does not exist yet reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-files-watch-'));
    const file = join(dir, 'games', 'pool', 'pool.rules');
    const changed: string[] = [];
    const errors: unknown[] = [];
    const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(e));
    mkdirSync(join(dir, 'games', 'pool'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(file, 'rules_version = \'2+modules\';');
    await until(() => changed.length > 0);
    watch.close();
    expect(errors).toEqual([]);
    expect(changed[0]).toBe(file);
  });
});
