/**
 * Field values written as JSON, asserted against the sandbox rather than
 * against the decoder's own claim.
 *
 * Every case here writes through a real method and reads the document back, so
 * what is pinned is what Firestore stored: the server timestamp is the pinned
 * clock's instant, the increment moved the number, the union and the removal
 * changed the array, and the deleted key is gone. A decoder that returned the
 * right object but reached the write plane wrong would pass a unit test and
 * fail these.
 *
 * The refusals are asserted as whole sentences. A refusal is what an agent
 * reads to correct itself, so the field path it names is the product.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../src/bridge/surface/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const PINNED = '2026-06-01T00:00:00.000Z';
const surface = renderSurface(undefined);

function freshContext(): SurfaceContext {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  return createSurfaceContext(sandbox, mkdtempSync(join(tmpdir(), 'pyric-field-values-')));
}

async function call(
  ctx: SurfaceContext,
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

/** The stored document at `path`, as the read method reports it. */
async function read(ctx: SurfaceContext, path: string): Promise<Record<string, unknown>> {
  const got = await call(ctx, 'firestore.getDoc', { path });
  return (got.data as { data: Record<string, unknown> }).data;
}

describe('$serverTimestamp carries the pinned instant', () => {
  it('through setDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    const written = await call(ctx, 'firestore.setDoc', {
      path: 'ledger/first',
      data: { at: { $serverTimestamp: true } },
    });

    expect(written.ok).toBe(true);
    const stored = (await read(ctx, 'ledger/first')).at as { seconds: number };
    expect(stored.seconds).toBe(Date.parse(PINNED) / 1000);
  });

  it('through updateDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'ledger/first', data: { at: 0 } });
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'firestore.updateDoc', {
      path: 'ledger/first',
      data: { at: { $serverTimestamp: true } },
    });

    const stored = (await read(ctx, 'ledger/first')).at as { seconds: number };
    expect(stored.seconds).toBe(Date.parse(PINNED) / 1000);
  });

  it('through addDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    const added = await call(ctx, 'firestore.addDoc', {
      path: 'ledger',
      data: { at: { $serverTimestamp: true } },
    });

    const path = (added.data as { path: string }).path;
    const stored = (await read(ctx, path)).at as { seconds: number };
    expect(stored.seconds).toBe(Date.parse(PINNED) / 1000);
  });

  it('through writeBatch, the same instant in both documents', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'firestore.writeBatch', {
      writes: [
        { type: 'set', path: 'ledger/first', data: { at: { $serverTimestamp: true } } },
        { type: 'set', path: 'ledger/second', data: { at: { $serverTimestamp: true } } },
      ],
    });

    const first = (await read(ctx, 'ledger/first')).at as { seconds: number };
    const second = (await read(ctx, 'ledger/second')).at as { seconds: number };
    expect(first.seconds).toBe(Date.parse(PINNED) / 1000);
    expect(second.seconds).toBe(first.seconds);
  });
});

describe('$increment adds to what is stored', () => {
  it('through updateDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'counters/hits', data: { total: 5 } });

    await call(ctx, 'firestore.updateDoc', {
      path: 'counters/hits',
      data: { total: { $increment: 3 } },
    });

    expect((await read(ctx, 'counters/hits')).total).toBe(8);
  });

  it('through writeBatch', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'counters/hits', data: { total: 5 } });

    await call(ctx, 'firestore.writeBatch', {
      writes: [{ type: 'update', path: 'counters/hits', data: { total: { $increment: -2 } } }],
    });

    expect((await read(ctx, 'counters/hits')).total).toBe(3);
  });

  it('through setDoc, starting from nothing', async () => {
    const ctx = freshContext();

    await call(ctx, 'firestore.setDoc', {
      path: 'counters/fresh',
      data: { total: { $increment: 4 } },
    });

    expect((await read(ctx, 'counters/fresh')).total).toBe(4);
  });

  it('through addDoc', async () => {
    const ctx = freshContext();

    const added = await call(ctx, 'firestore.addDoc', {
      path: 'counters',
      data: { total: { $increment: 7 } },
    });

    const path = (added.data as { path: string }).path;
    expect((await read(ctx, path)).total).toBe(7);
  });
});

describe('$arrayUnion and $arrayRemove change the array', () => {
  it('union adds through updateDoc, and adds nothing twice', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'posts/p1', data: { tags: ['a'] } });

    await call(ctx, 'firestore.updateDoc', {
      path: 'posts/p1',
      data: { tags: { $arrayUnion: ['a', 'b'] } },
    });

    expect((await read(ctx, 'posts/p1')).tags).toEqual(['a', 'b']);
  });

  it('remove drops through updateDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'posts/p1', data: { tags: ['a', 'b', 'c'] } });

    await call(ctx, 'firestore.updateDoc', {
      path: 'posts/p1',
      data: { tags: { $arrayRemove: ['b'] } },
    });

    expect((await read(ctx, 'posts/p1')).tags).toEqual(['a', 'c']);
  });

  it('union through writeBatch', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'posts/p1', data: { tags: ['a'] } });

    await call(ctx, 'firestore.writeBatch', {
      writes: [{ type: 'update', path: 'posts/p1', data: { tags: { $arrayUnion: ['z'] } } }],
    });

    expect((await read(ctx, 'posts/p1')).tags).toEqual(['a', 'z']);
  });

  it('union through addDoc', async () => {
    const ctx = freshContext();

    const added = await call(ctx, 'firestore.addDoc', {
      path: 'posts',
      data: { tags: { $arrayUnion: ['a', 'b'] } },
    });

    const path = (added.data as { path: string }).path;
    expect((await read(ctx, path)).tags).toEqual(['a', 'b']);
  });
});

describe('$deleteField removes the key', () => {
  it('through updateDoc', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'users/alice', data: { role: 'admin', tmp: 1 } });

    await call(ctx, 'firestore.updateDoc', {
      path: 'users/alice',
      data: { tmp: { $deleteField: true } },
    });

    expect(await read(ctx, 'users/alice')).toEqual({ role: 'admin' });
  });

  it('through a writeBatch update', async () => {
    const ctx = freshContext();
    await call(ctx, 'firestore.setDoc', { path: 'users/alice', data: { role: 'admin', tmp: 1 } });

    await call(ctx, 'firestore.writeBatch', {
      writes: [{ type: 'update', path: 'users/alice', data: { tmp: { $deleteField: true } } }],
    });

    expect(await read(ctx, 'users/alice')).toEqual({ role: 'admin' });
  });
});

describe('a field value nested inside the document', () => {
  it('decodes below the top level', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'firestore.setDoc', {
      path: 'ledger/nested',
      data: { audit: { at: { $serverTimestamp: true } } },
    });

    const audit = (await read(ctx, 'ledger/nested')).audit as { at: { seconds: number } };
    expect(audit.at.seconds).toBe(Date.parse(PINNED) / 1000);
  });
});

describe('a spelling the decoder does not accept is refused', () => {
  it('names the field path and the spellings', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.setDoc', {
      path: 'ledger/first',
      data: { at: { $now: true } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.at names $now, which is not a field value.');
    expect(refused.summary).toContain('{"$serverTimestamp": true}');
  });

  it('refuses an object carrying a $ key beside a plain one', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.setDoc', {
      path: 'ledger/first',
      data: { at: { $increment: 1, also: 2 } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('A field value is an object with exactly one key');
  });

  it('refuses $increment with something that is not a number', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.updateDoc', {
      path: 'counters/hits',
      data: { total: { $increment: 'three' } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.total holds $increment with "three".');
    expect(refused.summary).toContain('{"$increment": <number>}');
  });

  it('refuses $arrayUnion with something that is not an array', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.updateDoc', {
      path: 'posts/p1',
      data: { tags: { $arrayUnion: 'a' } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.tags holds $arrayUnion with "a".');
  });

  it('names the field path inside a nested object', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.setDoc', {
      path: 'ledger/first',
      data: { audit: { at: { $serverTimestamp: 'yes' } } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.audit.at holds $serverTimestamp with "yes".');
  });

  it('names the write index inside a batch', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.writeBatch', {
      writes: [
        { type: 'set', path: 'ledger/first', data: { at: { $serverTimestamp: true } } },
        { type: 'set', path: 'ledger/second', data: { at: { $nope: true } } },
      ],
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('writes.1.data.at names $nope, which is not a field value.');
  });
});

describe('$deleteField is refused where the SDK does not accept it', () => {
  it('in setDoc, naming the method', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.setDoc', {
      path: 'users/alice',
      data: { tmp: { $deleteField: true } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.tmp holds $deleteField, which setDoc does not accept.');
    expect(refused.summary).toContain('accepted by updateDoc');
  });

  it('in addDoc, naming the method', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.addDoc', {
      path: 'users',
      data: { tmp: { $deleteField: true } },
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('data.tmp holds $deleteField, which addDoc does not accept.');
  });

  it('in a writeBatch set, naming the entry', async () => {
    const ctx = freshContext();

    const refused = await call(ctx, 'firestore.writeBatch', {
      writes: [{ type: 'set', path: 'users/alice', data: { tmp: { $deleteField: true } } }],
    });

    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain(
      'writes.0.data.tmp holds $deleteField, which a writeBatch set does not accept.',
    );
  });
});

describe('the Realtime Database server timestamp is Firebase\'s own wire form', () => {
  it('set resolves {".sv": "timestamp"} to the pinned clock', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'database.set', {
      path: 'rooms/lobby',
      value: { at: { '.sv': 'timestamp' } },
    });

    const got = await call(ctx, 'database.get', { path: 'rooms/lobby' });
    expect((got.data as { value: { at: number } }).value.at).toBe(Date.parse(PINNED));
  });

  it('update resolves it too', async () => {
    const ctx = freshContext();
    await call(ctx, 'database.set', { path: 'rooms/lobby', value: { name: 'Lobby' } });
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'database.update', {
      path: 'rooms/lobby',
      values: { at: { '.sv': 'timestamp' } },
    });

    const got = await call(ctx, 'database.get', { path: 'rooms/lobby' });
    expect((got.data as { value: { name: string; at: number } }).value).toEqual({
      name: 'Lobby',
      at: Date.parse(PINNED),
    });
  });

  it('resolves one nested below the top level', async () => {
    const ctx = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: PINNED });

    await call(ctx, 'database.set', {
      path: 'rooms/lobby',
      value: { audit: { at: { '.sv': 'timestamp' } } },
    });

    const got = await call(ctx, 'database.get', { path: 'rooms/lobby' });
    expect((got.data as { value: { audit: { at: number } } }).value.audit.at)
      .toBe(Date.parse(PINNED));
  });
});
