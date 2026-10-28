/**
 * A rules file is watched through its directory. A missing directory is
 * watched through its nearest existing ancestor. When the next path segment
 * appears, the watch moves down to it, after the directory watcher's callback
 * returns, so a watcher is never closed from inside its own callback. A fake
 * file system keeps real fs.watch out of the shared test process.
 */
import { expect, test } from 'bun:test';
import type { FSWatcher } from 'node:fs';
import { watchFileOrWhenCreatedWith, watchRulesFiles } from '../../src/serve/rules-files-watch.ts';

interface FakeWatcher {
  path: string;
  listener: (event: string, name: string | Buffer | null) => void;
  errorHandlers: ((error: unknown) => void)[];
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
    const watcher: FakeWatcher = { path, listener, errorHandlers: [], closed: false };
    watchers.push(watcher);
    return {
      close() {
        if (dispatching === watcher) closedDuringOwnCallback.push(path);
        watcher.closed = true;
      },
      on(event: string, handler: (error: unknown) => void) {
        if (event === 'error') watcher.errorHandlers.push(handler);
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

function fail(path: string, error: Error): void {
  const watcher = watchers.find((w) => w.path === path && !w.closed)!;
  for (const handler of watcher.errorHandlers) handler(error);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const openUnder = (root: string) => watchers.filter((w) => !w.closed && w.path.startsWith(root)).map((w) => w.path);

test('a watch moves down to a new directory after the callback that saw it returns, and reports the file when it is created there', async () => {
  const file = '/p/games/a.rules';
  existing.add('/p');
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  expect(openUnder('/p')).toEqual(['/p']);

  existing.add('/p/games');
  fire('/p', 'games');
  await tick();
  expect(openUnder('/p')).toEqual(['/p/games']);
  expect(changed).toEqual([]);

  existing.add(file);
  fire('/p/games', 'a.rules');
  await tick();
  expect(openUnder('/p')).toEqual(['/p/games']);
  expect(changed).toEqual([file]);

  fire('/p/games', 'other.rules');
  expect(changed).toEqual([file]);

  expect(closedDuringOwnCallback).toEqual([]);
  watch.close();
});

test('a file created with its directory is reported when the watch moves down', async () => {
  const file = '/r/games/c.rules';
  existing.add('/r');
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  existing.add('/r/games');
  existing.add(file);
  fire('/r', 'games');
  await tick();
  expect(openUnder('/r')).toEqual(['/r/games']);
  expect(changed).toEqual([file]);
  watch.close();
});

test('a file created with several missing directories is reported when the watch moves down past them', async () => {
  const file = '/s/games/pool/pool.rules';
  existing.add('/s');
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  expect(openUnder('/s')).toEqual(['/s']);

  // `mkdir -p games/pool` and the write both land before the watch moves.
  existing.add('/s/games');
  existing.add('/s/games/pool');
  existing.add(file);
  fire('/s', 'games');
  await tick();
  expect(openUnder('/s')).toEqual(['/s/games/pool']);
  expect(changed).toEqual([file]);
  watch.close();
});

test('a watch that moves down past missing directories reports nothing while the file is still missing', async () => {
  const file = '/t/games/pool/pool.rules';
  existing.add('/t');
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  existing.add('/t/games');
  existing.add('/t/games/pool');
  fire('/t', 'games');
  await tick();
  expect(openUnder('/t')).toEqual(['/t/games/pool']);
  expect(changed).toEqual([]);

  existing.add(file);
  fire('/t/games/pool', 'pool.rules');
  expect(changed).toEqual([file]);
  watch.close();
});

test('a watched file that is deleted and created again is reported both times', async () => {
  const file = '/q/b.rules';
  existing.add('/q');
  existing.add(file);
  const changed: string[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => { throw e; }, watchFileOrWhenCreatedWith(fileSystem));
  expect(openUnder('/q')).toEqual(['/q']);

  existing.delete(file);
  fire('/q', 'b.rules');
  expect(changed).toEqual([file]);

  existing.add(file);
  fire('/q', 'b.rules');
  expect(changed).toEqual([file, file]);
  expect(openUnder('/q')).toEqual(['/q']);

  expect(closedDuringOwnCallback).toEqual([]);
  watch.close();
});

test('a watch that fails with ENOENT is armed again and reports a change', async () => {
  // Bun opens each entry of a newly watched directory after watch() returns,
  // and fails the watch with ENOENT when an entry is deleted first.
  const file = '/u/c.rules';
  existing.add('/u');
  existing.add(file);
  const changed: string[] = [];
  const errors: unknown[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(e), watchFileOrWhenCreatedWith(fileSystem));
  const first = watchers.find((w) => w.path === '/u' && !w.closed)!;

  existing.delete(file);
  fail('/u', missing(file));
  await tick();
  expect(first.closed).toBe(true);
  expect(openUnder('/u')).toEqual(['/u']);
  expect(changed).toEqual([file]);
  expect(errors).toEqual([]);

  existing.add(file);
  fire('/u', 'c.rules');
  expect(changed).toEqual([file, file]);
  watch.close();
});

test('a watch error other than ENOENT is reported and the watch is not armed again', async () => {
  const file = '/v/d.rules';
  existing.add('/v');
  const changed: string[] = [];
  const errors: unknown[] = [];
  const watch = watchRulesFiles(() => [file], (f) => changed.push(f), (e) => errors.push(e), watchFileOrWhenCreatedWith(fileSystem));
  const denied = Object.assign(new Error("EACCES: permission denied, watch '/v'"), { code: 'EACCES' });
  fail('/v', denied);
  await tick();
  expect(errors).toEqual([denied]);
  expect(changed).toEqual([]);
  expect(watchers.filter((w) => w.path === '/v')).toHaveLength(1);
  watch.close();
});
