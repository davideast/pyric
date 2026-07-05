import { describe, test, expect } from 'bun:test';
import { LocalState } from 'pyric/sandbox/internal';

describe('LocalState', () => {

  // ═══ Seeding ═══

  describe('seeding', () => {
    test('empty seed', () => {
      const state = new LocalState();
      expect(state.size()).toBe(0);
    });

    test('seed with documents', () => {
      const state = new LocalState({
        'users/alice': { name: 'Alice', role: 'admin' },
        'users/bob': { name: 'Bob', role: 'member' },
      });
      expect(state.size()).toBe(2);
      expect(state.get('users/alice')).toEqual({ name: 'Alice', role: 'admin' });
    });

    test('seed data is copied (not referenced)', () => {
      const data = { name: 'Alice' };
      const state = new LocalState({ 'users/alice': data });
      data.name = 'MUTATED';
      expect(state.get('users/alice')!.name).toBe('Alice');
    });
  });

  // ═══ Read operations ═══

  describe('get', () => {
    test('returns document data', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      expect(state.get('users/alice')).toEqual({ name: 'Alice' });
    });

    test('returns null for missing document', () => {
      const state = new LocalState();
      expect(state.get('users/alice')).toBe(null);
    });
  });

  describe('exists', () => {
    test('true for existing document', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      expect(state.exists('users/alice')).toBe(true);
    });

    test('false for missing document', () => {
      const state = new LocalState();
      expect(state.exists('users/alice')).toBe(false);
    });
  });

  describe('scan projection', () => {
    test('emits only the projected top-level fields', () => {
      const state = new LocalState({
        'items/a': { name: 'A', vector: [1, 2, 3], tags: ['x'] },
        'items/b': { name: 'B', vector: [4, 5, 6] },
      });
      const rows = state.scan('items', { directOnly: true, projection: ['name'] });
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.path === 'items/a')!.data).toEqual({ name: 'A' });
      expect(rows.find((r) => r.path === 'items/b')!.data).toEqual({ name: 'B' });
    });

    test('a projected field that is absent is simply omitted', () => {
      const state = new LocalState({ 'items/a': { name: 'A' } });
      const rows = state.scan('items', { directOnly: true, projection: ['name', 'vector'] });
      expect(rows.find((r) => r.path === 'items/a')!.data).toEqual({ name: 'A' });
    });

    test('no projection returns full docs unchanged', () => {
      const state = new LocalState({ 'items/a': { name: 'A', vector: [1, 2, 3] } });
      const rows = state.scan('items', { directOnly: true });
      expect(rows.find((r) => r.path === 'items/a')!.data).toEqual({ name: 'A', vector: [1, 2, 3] });
    });
  });

  describe('list', () => {
    test('lists direct children of a collection', () => {
      const state = new LocalState({
        'users/alice': { name: 'Alice' },
        'users/bob': { name: 'Bob' },
        'posts/p1': { title: 'Hello' },
      });
      const users = state.list('users');
      expect(users).toHaveLength(2);
      expect(users.map(u => u.path).sort()).toEqual(['users/alice', 'users/bob']);
    });

    test('does not include subcollection documents', () => {
      const state = new LocalState({
        'users/alice': { name: 'Alice' },
        'users/alice/posts/p1': { title: 'Post' },
      });
      const users = state.list('users');
      expect(users).toHaveLength(1);
      expect(users[0].path).toBe('users/alice');
    });

    test('empty collection', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      expect(state.list('posts')).toHaveLength(0);
    });

    test('collection with trailing slash', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      expect(state.list('users/')).toHaveLength(1);
    });

    // Item 4 — phantom parent docs.
    describe('phantom parents', () => {
      test('synthesizes a phantom for a parent id whose only existence is a descendant path', () => {
        const state = new LocalState({
          'users/u1/posts/p1': { title: 'Hello' },
        });
        const users = state.list('users');
        expect(users).toHaveLength(1);
        expect(users[0]).toEqual({ path: 'users/u1', data: {}, phantom: true });
        // get() must NOT synthesize — only list does.
        expect(state.get('users/u1')).toBeNull();
      });

      test('a real stored doc wins over a phantom for the same id', () => {
        const state = new LocalState({
          'users/u1': { name: 'real' },
          'users/u1/posts/p1': { title: 'Hello' },
        });
        const users = state.list('users');
        expect(users).toHaveLength(1);
        // The stored doc — no phantom flag, real data preserved.
        expect(users[0].path).toBe('users/u1');
        expect(users[0].data).toEqual({ name: 'real' });
        expect(users[0].phantom).toBeUndefined();
      });

      test('phantoms dedupe across multiple descendants of the same parent', () => {
        const state = new LocalState({
          'users/u1/posts/p1': { t: 1 },
          'users/u1/posts/p2': { t: 2 },
          'users/u1/sessions/s1': { active: true },
        });
        const users = state.list('users');
        expect(users).toHaveLength(1);
        expect(users[0].path).toBe('users/u1');
        expect(users[0].phantom).toBe(true);
      });

      test('mixes real children and phantom parents in the same listing', () => {
        const state = new LocalState({
          'users/alice': { name: 'Alice' },
          'users/u2/posts/p1': { title: 'phantom owner' },
        });
        const users = state.list('users');
        const byPath = Object.fromEntries(users.map(u => [u.path, u]));
        expect(Object.keys(byPath).sort()).toEqual(['users/alice', 'users/u2']);
        expect(byPath['users/alice']!.phantom).toBeUndefined();
        expect(byPath['users/u2']!.phantom).toBe(true);
        expect(byPath['users/u2']!.data).toEqual({});
      });

      test('phantom synthesis only kicks in for the queried collection', () => {
        const state = new LocalState({
          'users/u1/posts/p1': { title: 'Hello' },
        });
        // Listing `posts` directly — there is no `posts` document path under
        // any root. Confirm we don't accidentally surface deep descendants
        // by mistake.
        expect(state.list('posts')).toHaveLength(0);
      });
    });
  });

  describe('snapshot', () => {
    test('returns all documents', () => {
      const state = new LocalState({ 'a/1': { x: 1 }, 'b/2': { y: 2 } });
      const snap = state.snapshot();
      expect(Object.keys(snap).sort()).toEqual(['a/1', 'b/2']);
    });

    test('snapshot is a copy', () => {
      const state = new LocalState({ 'a/1': { x: 1 } });
      const snap = state.snapshot();
      snap['a/1'].x = 999;
      expect(state.get('a/1')!.x).toBe(1);
    });
  });

  // ═══ Create ═══

  describe('create', () => {
    test('creates new document', () => {
      const state = new LocalState();
      const result = state.create('users/alice', { name: 'Alice' });
      expect(result.success).toBe(true);
      expect(state.get('users/alice')).toEqual({ name: 'Alice' });
    });

    test('fails if document exists', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      const result = state.create('users/alice', { name: 'New Alice' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(state.get('users/alice')!.name).toBe('Alice'); // unchanged
    });

    test('data is copied', () => {
      const state = new LocalState();
      const data = { name: 'Alice' };
      state.create('users/alice', data);
      data.name = 'MUTATED';
      expect(state.get('users/alice')!.name).toBe('Alice');
    });
  });

  // ═══ Update (merge semantics) ═══

  describe('update', () => {
    test('merges fields — preserves existing, adds new', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice', role: 'admin', age: 30 } });
      const result = state.update('users/alice', { role: 'member', email: 'alice@test.com' });
      expect(result.success).toBe(true);
      expect(state.get('users/alice')).toEqual({
        name: 'Alice',    // preserved
        role: 'member',   // updated
        age: 30,          // preserved
        email: 'alice@test.com',  // added
      });
    });

    test('returns prior data', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice', role: 'admin' } });
      const result = state.update('users/alice', { role: 'member' });
      expect(result.priorData).toEqual({ name: 'Alice', role: 'admin' });
    });

    test('fails if document does not exist', () => {
      const state = new LocalState();
      const result = state.update('users/alice', { name: 'Alice' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    test('does not replace entire document', () => {
      const state = new LocalState({ 'users/alice': { a: 1, b: 2, c: 3 } });
      state.update('users/alice', { b: 99 });
      expect(state.get('users/alice')).toEqual({ a: 1, b: 99, c: 3 });
    });
  });

  // ═══ Set (overwrite) ═══

  describe('set', () => {
    test('creates document if not exists', () => {
      const state = new LocalState();
      const result = state.set('users/alice', { name: 'Alice' });
      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.priorData).toBe(null);
      expect(state.get('users/alice')).toEqual({ name: 'Alice' });
    });

    test('overwrites existing document (full replace, not merge)', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice', role: 'admin', age: 30 } });
      const result = state.set('users/alice', { name: 'Alice Updated' });
      expect(result.success).toBe(true);
      expect(result.created).toBe(false);
      expect(result.priorData).toEqual({ name: 'Alice', role: 'admin', age: 30 });
      expect(state.get('users/alice')).toEqual({ name: 'Alice Updated' }); // role, age gone
    });
  });

  // ═══ Delete ═══

  describe('delete', () => {
    test('removes document', () => {
      const state = new LocalState({ 'users/alice': { name: 'Alice' } });
      const result = state.delete('users/alice');
      expect(result.success).toBe(true);
      expect(result.priorData).toEqual({ name: 'Alice' });
      expect(state.exists('users/alice')).toBe(false);
    });

    test('fails if document does not exist', () => {
      const state = new LocalState();
      const result = state.delete('users/alice');
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  // ═══ Batch ═══

  describe('applyBatch', () => {
    test('applies all operations atomically', () => {
      const state = new LocalState({
        'games/g1': { status: 'playing', host: 'alice' },
        'lobbies/l1': { host: 'alice' },
      });
      const result = state.applyBatch([
        { method: 'update', path: 'games/g1', data: { status: 'finished', winner: 'alice' } },
        { method: 'create', path: 'results/r1', data: { winner: 'alice', score: 100 } },
        { method: 'delete', path: 'lobbies/l1' },
      ]);
      expect(result.success).toBe(true);
      expect(state.get('games/g1')!.status).toBe('finished');
      expect(state.get('games/g1')!.host).toBe('alice'); // merge preserved
      expect(state.exists('results/r1')).toBe(true);
      expect(state.exists('lobbies/l1')).toBe(false);
    });

    test('all-or-nothing: fails if any operation fails', () => {
      const state = new LocalState({
        'games/g1': { status: 'playing' },
      });
      const result = state.applyBatch([
        { method: 'update', path: 'games/g1', data: { status: 'finished' } },
        { method: 'update', path: 'games/g2', data: { status: 'finished' } }, // doesn't exist
      ]);
      expect(result.success).toBe(false);
      // NONE of the operations should have applied
      expect(state.get('games/g1')!.status).toBe('playing'); // unchanged
    });

    test('returns prior states for undo', () => {
      const state = new LocalState({
        'games/g1': { status: 'playing' },
        'lobbies/l1': { host: 'alice' },
      });
      const result = state.applyBatch([
        { method: 'update', path: 'games/g1', data: { status: 'done' } },
        { method: 'delete', path: 'lobbies/l1' },
        { method: 'create', path: 'results/r1', data: { score: 10 } },
      ]);
      expect(result.success).toBe(true);
      expect(result.priorStates!.get('games/g1')).toEqual({ status: 'playing' });
      expect(result.priorStates!.get('lobbies/l1')).toEqual({ host: 'alice' });
      expect(result.priorStates!.get('results/r1')).toBe(null); // didn't exist before
    });

    test('create in batch fails if document exists', () => {
      const state = new LocalState({ 'x/1': { a: 1 } });
      const result = state.applyBatch([
        { method: 'create', path: 'x/1', data: { a: 2 } },
      ]);
      expect(result.success).toBe(false);
      expect(result.errors![0].error).toContain('already exists');
    });

    test('set in batch always succeeds (create or overwrite)', () => {
      const state = new LocalState({ 'x/1': { a: 1 } });
      const result = state.applyBatch([
        { method: 'set', path: 'x/1', data: { b: 2 } },
        { method: 'set', path: 'x/2', data: { c: 3 } },
      ]);
      expect(result.success).toBe(true);
      expect(state.get('x/1')).toEqual({ b: 2 }); // overwritten
      expect(state.get('x/2')).toEqual({ c: 3 }); // created
    });

    test('no cross-visibility: operations see pre-batch state', () => {
      // This tests that a create in position 0 is NOT visible to an
      // operation in position 1. Each operation validates against the
      // state BEFORE the batch started.
      const state = new LocalState();
      const result = state.applyBatch([
        { method: 'create', path: 'x/1', data: { a: 1 } },
        { method: 'update', path: 'x/1', data: { b: 2 } }, // x/1 doesn't exist in pre-batch state
      ]);
      expect(result.success).toBe(false);
      expect(result.errors!.some(e => e.error.includes('does not exist'))).toBe(true);
    });
  });

  // ═══ Restore ═══

  describe('restore', () => {
    test('replaces all state from snapshot', () => {
      const state = new LocalState({ 'a/1': { x: 1 }, 'b/2': { y: 2 } });
      state.restore({ 'c/3': { z: 3 } });
      expect(state.size()).toBe(1);
      expect(state.get('a/1')).toBe(null);
      expect(state.get('c/3')).toEqual({ z: 3 });
    });
  });

  // ═══ Chess game sequence ═══

  describe('chess game sequence', () => {
    test('create → update → update → delete lifecycle', () => {
      const state = new LocalState({
        'gameConfig/chess': { moves: {} },
      });

      // Create game
      const c = state.create('chess/g1', {
        host: 'white', guest: '', status: 'waiting',
        e1: 'K', b1: 'N', e8: 'k',
      });
      expect(c.success).toBe(true);

      // Join game (merge)
      const j = state.update('chess/g1', { guest: 'black', status: 'playing' });
      expect(j.success).toBe(true);
      expect(state.get('chess/g1')!.host).toBe('white');      // preserved
      expect(state.get('chess/g1')!.guest).toBe('black');     // added
      expect(state.get('chess/g1')!.status).toBe('playing');  // updated
      expect(state.get('chess/g1')!.e1).toBe('K');            // preserved

      // Make move (merge)
      const m = state.update('chess/g1', {
        b1: '', c3: 'N', currentTurn: 'guest', moveCount: 1,
      });
      expect(m.success).toBe(true);
      expect(state.get('chess/g1')!.b1).toBe('');
      expect(state.get('chess/g1')!.c3).toBe('N');
      expect(state.get('chess/g1')!.e1).toBe('K');  // still there

      // Game over — delete
      const d = state.delete('chess/g1');
      expect(d.success).toBe(true);
      expect(d.priorData!.c3).toBe('N');
      expect(state.exists('chess/g1')).toBe(false);
    });
  });
});
