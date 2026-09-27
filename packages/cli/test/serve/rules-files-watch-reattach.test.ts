/**
 * A missing rules file is watched through its nearest existing ancestor. When
 * the next path segment appears, the watch moves down to it, after the
 * directory watcher's callback returns, so a watcher is never closed from
 * inside its own callback. A fake file system keeps real fs.watch out of the
 * shared test process.
 */
import { expect, test } from 'bun:test';
import type { FSWatcher } from 'node:fs';
import { watchFileOrWhenCreatedWith, watchRulesFiles } from '../../src/serve/rules-files-watch.ts';

interface FakeWatcher {
  path: string;
  listener: (event: string, name: string | Buffer | null) => void;
  closed: boolean;
}

const existing = new Set<string>();
const watchers: FakeWatcher[] = [];
let dispatching: FakeWatcher | null = null;
const closedDuringOwnCallback: string[] = [];

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, watch '${path}'`), { code: 'ENOENT' });
}

const fileSystem = {
  existsSync: (path: string) => existing.has(path),
  watch: (path: string, listener: FakeWatcher['listener']) => {
    if (!existing.has(path)) throw missing(path);
    const watcher: FakeWatcher = { path, listener, closed: false };
    watchers.push(watcher);
    return {
      close() {
        if (dispatching === watcher) closedDuringOwnCallback.push(path);
        watcher.closed = true;
      },
      on() {
        return this;
      },
    } as unknown as FSWatcher;
  },
};

function fire(path: string, name: string): void {
  const watcher = watchers.find((w) => w.path === path && !w.closed)!;
  dispatching = watcher;
  try {
    watcher.listener('rename', name);
  } finally {
    dispatching = null;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a watch moves to a new directory and to the new file after the callback that saw them returns', async () => {
  const file = '/p/games/a.rules';
  existing.add('/p');
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  expect(watchers.map((w) => w.path)).toEqual(['/p']);

  existing.add('/p/games');
  fire('/p', 'games');
  await tick();
  expect(watchers.filter((w) => !w.closed).map((w) => w.path)).toEqual(['/p/games']);

  existing.add(file);
  fire('/p/games', 'a.rules');
  await tick();
  expect(watchers.filter((w) => !w.closed).map((w) => w.path)).toEqual([file]);
  expect(changed).toEqual([file]);

  expect(closedDuringOwnCallback).toEqual([]);
  watch.close();
});

test('a watched file that is deleted is watched through its directory until it is created again', async () => {
  const file = '/q/b.rules';
  existing.add('/q');
  existing.add(file);
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  const open = () => watchers.filter((w) => !w.closed && w.path.startsWith('/q')).map((w) => w.path);
  expect(open()).toEqual([file]);

  existing.delete(file);
  fire(file, 'b.rules');
  await tick();
  expect(open()).toEqual(['/q']);
  expect(changed).toEqual([file]);

  existing.add(file);
  fire('/q', 'b.rules');
  await tick();
  expect(open()).toEqual([file]);
  expect(changed).toEqual([file, file]);

  expect(closedDuringOwnCallback).toEqual([]);
  watch.close();
});
