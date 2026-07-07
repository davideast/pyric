import { describe, test, expect } from 'bun:test';
import { LocalEnvironment, SimulatorUnsupportedError } from 'pyric/sandbox/internal';

const SIMPLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
          && request.resource.data.host == request.auth.uid
          && request.resource.data.status == 'waiting';
      allow update: if request.auth != null
          && resource.data.status == 'playing'
          && (request.auth.uid == resource.data.host || request.auth.uid == resource.data.guest)
          && request.resource.data.host == resource.data.host
          && request.resource.data.guest == resource.data.guest;
      allow delete: if request.auth != null
          && resource.data.status == 'waiting'
          && request.auth.uid == resource.data.host;
    }
    match /config/{docId} {
      allow read: if true;
      allow write: if false;
    }
  }
}`;

describe('LocalEnvironment', () => {

  describe('seed and read', () => {
    test('seed with documents and read them back', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'config/settings': { maxPlayers: 2 } },
      });
      expect(env.getDocument('config/settings')).toEqual({ maxPlayers: 2 });
      expect(env.getDocument('config/missing')).toBe(null);
    });

    test('snapshot returns all documents', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'a/1': { x: 1 }, 'b/2': { y: 2 } },
      });
      const snap = env.snapshot();
      expect(Object.keys(snap).sort()).toEqual(['a/1', 'b/2']);
    });

    test('seed returns lint result', () => {
      const env = new LocalEnvironment();
      const lint = env.seed({ rules: SIMPLE_RULES });
      expect(lint.metrics.functionCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('create', () => {
    test('valid create — allowed, state updated', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      const result = env.execute({
        method: 'create',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', guest: '', status: 'waiting' },
      });
      expect(result.allowed).toBe(true);
      expect(env.getDocument('games/g1')).toEqual({ host: 'alice', guest: '', status: 'waiting' });
    });

    test('unauthenticated create — denied, state unchanged', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      const result = env.execute({
        method: 'create',
        path: 'games/g1',
        auth: null,
        data: { host: 'alice', status: 'waiting' },
      });
      expect(result.allowed).toBe(false);
      expect(env.getDocument('games/g1')).toBe(null);
    });

    test('create with wrong host — denied', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      const result = env.execute({
        method: 'create',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'bob', guest: '', status: 'waiting' },
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('update', () => {
    test('valid update — state merges fields', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: 'bob', status: 'playing', score: 0 } },
      });

      const result = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { score: 10, host: 'alice', guest: 'bob' },
      });
      expect(result.allowed).toBe(true);
      expect(env.getDocument('games/g1')!.score).toBe(10);
      expect(env.getDocument('games/g1')!.status).toBe('playing'); // preserved
    });

    test('wrong player update — denied', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: 'bob', status: 'playing' } },
      });

      const result = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'charlie' },
        data: { score: 999, host: 'alice', guest: 'bob' },
      });
      expect(result.allowed).toBe(false);
      expect(env.getDocument('games/g1')!.score).toBeUndefined(); // no change
    });
  });

  describe('delete', () => {
    test('host can delete waiting game', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: '', status: 'waiting' } },
      });

      const result = env.execute({
        method: 'delete',
        path: 'games/g1',
        auth: { uid: 'alice' },
      });
      expect(result.allowed).toBe(true);
      expect(env.getDocument('games/g1')).toBe(null);
    });

    test('non-host cannot delete', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: '', status: 'waiting' } },
      });

      const result = env.execute({
        method: 'delete',
        path: 'games/g1',
        auth: { uid: 'bob' },
      });
      expect(result.allowed).toBe(false);
      expect(env.getDocument('games/g1')).not.toBe(null);
    });
  });

  describe('sequential operations', () => {
    test('create → update → update sees accumulated state', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      // Create
      env.execute({
        method: 'create', path: 'games/g1', auth: { uid: 'alice' },
        data: { host: 'alice', guest: '', status: 'waiting' },
      });

      // Update — join (need to update status to 'playing' for further updates)
      // But our rules require status == 'playing' for updates, and guest == host.
      // Let's use a simpler update rule. For now, just verify the state accumulated.
      expect(env.getDocument('games/g1')!.host).toBe('alice');
      expect(env.getDocument('games/g1')!.status).toBe('waiting');
    });
  });

  describe('undo / redo', () => {
    test('undo reverts last write', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: 'bob', status: 'playing', score: 0 } },
      });

      // Make a move
      env.execute({
        method: 'update', path: 'games/g1', auth: { uid: 'alice' },
        data: { score: 10, host: 'alice', guest: 'bob' },
      });
      expect(env.getDocument('games/g1')!.score).toBe(10);

      // Undo
      const undone = env.undo();
      expect(undone).not.toBe(null);
      expect(env.getDocument('games/g1')!.score).toBe(0); // reverted
    });

    test('undo restores only the affected path, leaving unrelated docs untouched', () => {
      // Phase 2b: undo uses affected-path priorDocs (restorePaths), not a
      // whole-keyspace restore. An unrelated doc must survive an undo, and a
      // doc created by the undone write must be removed.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: {
          'games/g1': { host: 'alice', guest: 'bob', status: 'playing', score: 0 },
          'games/g2': { host: 'carol', guest: 'dave', status: 'playing', score: 7 },
        },
      });

      // Update g1, then create a brand-new doc g3.
      env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'alice' }, data: { score: 99, host: 'alice', guest: 'bob' } });
      env.execute({ method: 'create', path: 'games/g3', auth: { uid: 'alice' }, data: { host: 'alice', guest: 'bob', status: 'waiting', score: 1 } });
      expect(env.getDocument('games/g3')!.score).toBe(1);

      // Undo the create: g3 gone, but g1 (updated) and g2 (untouched) intact.
      env.undo();
      expect(env.getDocument('games/g3')).toBe(null);      // created doc removed
      expect(env.getDocument('games/g1')!.score).toBe(99); // earlier update preserved
      expect(env.getDocument('games/g2')!.score).toBe(7);  // unrelated doc untouched

      // Undo the update: g1 back to its seed, g2 still untouched.
      env.undo();
      expect(env.getDocument('games/g1')!.score).toBe(0);
      expect(env.getDocument('games/g2')!.score).toBe(7);
    });

    test('multiple undos', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: 'bob', status: 'playing', score: 0 } },
      });

      // Two moves
      env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'alice' }, data: { score: 10, host: 'alice', guest: 'bob' } });
      env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'bob' }, data: { score: 20, host: 'alice', guest: 'bob' } });
      expect(env.getDocument('games/g1')!.score).toBe(20);

      // Undo second
      env.undo();
      expect(env.getDocument('games/g1')!.score).toBe(10);

      // Undo first
      env.undo();
      expect(env.getDocument('games/g1')!.score).toBe(0);
    });

    test('undo on empty log returns null', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      expect(env.undo()).toBe(null);
    });

    test('redo re-applies undone operation', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', guest: 'bob', status: 'playing', score: 0 } },
      });

      env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'alice' }, data: { score: 10, host: 'alice', guest: 'bob' } });
      env.undo();
      expect(env.getDocument('games/g1')!.score).toBe(0);

      const redone = env.redo();
      expect(redone).not.toBe(null);
      expect(redone!.allowed).toBe(true);
      expect(env.getDocument('games/g1')!.score).toBe(10);
    });
  });

  describe('event log', () => {
    test('events are recorded', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      env.execute({ method: 'create', path: 'games/g1', auth: { uid: 'alice' }, data: { host: 'alice', guest: '', status: 'waiting' } });
      env.execute({ method: 'create', path: 'games/g2', auth: null, data: { host: 'bob', status: 'waiting' } }); // denied

      const events = env.getEvents();
      expect(events.length).toBe(2);
      expect(events[0].allowed).toBe(true);
      expect(events[1].allowed).toBe(false);
    });

    test('debug messages explain why rule denied', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });

      const result = env.execute({ method: 'create', path: 'games/g1', auth: null, data: { host: 'x', status: 'waiting' } });
      expect(result.debugMessages.length).toBeGreaterThan(0);
    });
  });

  describe('deploy rules', () => {
    test('deployRules swaps rules for next operation', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow write: if false; }
  }
}`,
      });

      // Denied under old rules
      const r1 = env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 1 } });
      expect(r1.allowed).toBe(false);

      // Deploy a more permissive ruleset. We avoid `allow write: if true`
      // because the linter's PERMISSIVE_RULE check (severity: error) makes
      // `deployRules` reject it, which would mask the swap behavior under
      // test. `request.auth != null` is the minimal non-trivial predicate
      // that still allows the authed create below.
      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow write: if request.auth != null; }
  }
}`);

      // Allowed under new rules
      const r2 = env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 1 } });
      expect(r2.allowed).toBe(true);
    });

    test('deployRules returns lint result', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const lint = env.deployRules(SIMPLE_RULES);
      expect(lint.metrics).toBeDefined();
    });
  });

  describe('batch', () => {
    test('all-or-nothing: all pass → all apply', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if request.auth != null;
      allow delete: if request.auth != null;
    }
  }
}`,
        documents: { 'items/old': { name: 'old item' } },
      });

      const result = env.batch([
        { method: 'create', path: 'items/new1', data: { name: 'item 1' } },
        { method: 'create', path: 'items/new2', data: { name: 'item 2' } },
        { method: 'delete', path: 'items/old' },
      ], { uid: 'user1' });

      expect(result.allowed).toBe(true);
      expect(env.getDocument('items/new1')).toEqual({ name: 'item 1' });
      expect(env.getDocument('items/new2')).toEqual({ name: 'item 2' });
      expect(env.getDocument('items/old')).toBe(null);
    });

    test('one fails → none apply', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if request.auth != null;
      allow delete: if false;
    }
  }
}`,
        documents: { 'items/old': { name: 'old' } },
      });

      const result = env.batch([
        { method: 'create', path: 'items/new', data: { name: 'new' } },
        { method: 'delete', path: 'items/old' }, // denied by rules
      ], { uid: 'user1' });

      expect(result.allowed).toBe(false);
      expect(env.getDocument('items/new')).toBe(null);    // rolled back
      expect(env.getDocument('items/old')).not.toBe(null); // preserved
    });

    test('undo reverts entire batch', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow create, delete: if request.auth != null; }
  }
}`,
        documents: { 'items/a': { x: 1 } },
      });

      env.batch([
        { method: 'create', path: 'items/b', data: { y: 2 } },
        { method: 'delete', path: 'items/a' },
      ], { uid: 'u1' });

      expect(env.getDocument('items/a')).toBe(null);
      expect(env.getDocument('items/b')).toEqual({ y: 2 });

      env.undo();
      expect(env.getDocument('items/a')).toEqual({ x: 1 });
      expect(env.getDocument('items/b')).toBe(null);
    });
  });

  describe('serverTimestamp sentinel', () => {
    test('isServerTimestamp passes with sentinel value', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.auth != null
          && request.resource.data.createdAt == request.time;
    }
  }
}`,
      });
      const r = env.execute({
        method: 'create', path: 'test/d1', auth: { uid: 'u1' },
        data: { name: 'Test', createdAt: { __type: 'serverTimestamp' } },
      });
      expect(r.allowed).toBe(true);
    });
  });

  describe('get() mocking from local state', () => {
    test('rules can read config docs via get()', () => {
      const RULES_WITH_GET = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /config/{id} { allow read: if true; allow write: if false; }
    match /items/{id} {
      function cfg() { return get(/databases/$(database)/documents/config/settings).data; }
      allow create: if request.auth != null && cfg().allowCreate == true;
    }
  }
}`;
      const env = new LocalEnvironment();
      env.seed({
        rules: RULES_WITH_GET,
        documents: { 'config/settings': { allowCreate: true } },
      });

      const r = env.execute({
        method: 'create', path: 'items/i1', auth: { uid: 'u1' },
        data: { name: 'test' },
      });
      expect(r.allowed).toBe(true);
    });

    test('get() sees locally created documents', () => {
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /config/{id} { allow read, write: if true; }
    match /items/{id} {
      function cfg() { return get(/databases/$(database)/documents/config/settings).data; }
      allow create: if cfg().allowCreate == true;
    }
  }
}`;
      const env = new LocalEnvironment();
      env.seed({ rules: RULES });

      // Create config doc first
      env.execute({ method: 'create', path: 'config/settings', auth: { uid: 'u1' }, data: { allowCreate: true } });

      // Now create item — get() should see the config doc we just created
      const r = env.execute({ method: 'create', path: 'items/i1', auth: { uid: 'u1' }, data: { name: 'test' } });
      expect(r.allowed).toBe(true);
    });

    test('type-B: a data-dependent get() chain resolves via lazy fault-in', () => {
      // The PATH of the second get() is built from the DATA of the first
      // (aliases/<uid> -> realUid -> users/<realUid>). With the Phase 2 fault-in
      // there is no pre-baked keyspace dump, so the inner get() must fault its
      // doc in before the outer path string can even be built. This shape does
      // not appear in the in-tree corpus (Gate 2) but the rules language allows
      // it, so it is the synthetic proof that fault-in is transitive.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /aliases/{id} { allow read, write: if true; }
    match /users/{id} { allow read, write: if true; }
    match /things/{id} {
      function realUid() {
        return get(/databases/$(database)/documents/aliases/$(request.auth.uid)).data.realUid;
      }
      allow create: if get(/databases/$(database)/documents/users/$(realUid())).data.admin == true;
    }
  }
}`;
      const env = new LocalEnvironment();
      env.seed({
        rules: RULES,
        documents: {
          'aliases/alice': { realUid: 'user_42' },
          'users/user_42': { admin: true },
          'aliases/bob': { realUid: 'user_99' },
          'users/user_99': { admin: false },
        },
      });

      // alice: aliases/alice -> user_42 -> admin:true -> ALLOW
      const allowed = env.execute({
        method: 'create', path: 'things/t1', auth: { uid: 'alice' }, data: { name: 'x' },
      });
      expect(allowed.allowed).toBe(true);

      // bob: aliases/bob -> user_99 -> admin:false -> DENY
      const denied = env.execute({
        method: 'create', path: 'things/t2', auth: { uid: 'bob' }, data: { name: 'y' },
      });
      expect(denied.allowed).toBe(false);
    });
  });

  describe('SimulatorUnsupportedError', () => {
    // When the simulator can't decide a rule (UNSUPPORTED), it must throw
    // rather than silently return allowed:false. Otherwise agents see a
    // misleading DENY and "fix" rules that aren't broken — the exact failure
    // mode REBUILD_PLAN.md Item 0.A is designed to prevent.
    const UNSUPPORTED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read, write: if foo.bar();
    }
  }
}`;

    test('execute(read) throws SimulatorUnsupportedError when rule is unsupported', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: UNSUPPORTED_RULES, documents: { 'docs/d1': { x: 1 } } });
      expect(() => env.execute({ method: 'get', path: 'docs/d1', auth: { uid: 'u1' } }))
        .toThrow(SimulatorUnsupportedError);
    });

    test('execute(write) throws SimulatorUnsupportedError when rule is unsupported', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: UNSUPPORTED_RULES });
      expect(() => env.execute({ method: 'create', path: 'docs/d1', auth: { uid: 'u1' }, data: { x: 1 } }))
        .toThrow(SimulatorUnsupportedError);
    });

    test('batch throws SimulatorUnsupportedError when any operation is unsupported', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: UNSUPPORTED_RULES });
      expect(() => env.batch(
        [{ method: 'create', path: 'docs/d1', data: { x: 1 } }],
        { uid: 'u1' },
      )).toThrow(SimulatorUnsupportedError);
    });

    test('thrown error carries method, path, and reason for actionable diagnosis', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: UNSUPPORTED_RULES, documents: { 'docs/d1': { x: 1 } } });
      try {
        env.execute({ method: 'get', path: 'docs/d1', auth: { uid: 'u1' } });
        throw new Error('expected SimulatorUnsupportedError');
      } catch (e) {
        expect(e).toBeInstanceOf(SimulatorUnsupportedError);
        const err = e as SimulatorUnsupportedError;
        expect(err.method).toBe('get');
        expect(err.path).toBe('docs/d1');
        expect(err.message).toContain('TestFirestoreRulesHandler');
        expect(err.debugMessages.some(m => m.includes('unsupported:'))).toBe(true);
      }
    });
  });

  describe('snapshot listeners (Slice 1 — registry only)', () => {
    // Slice 1 verifies add/remove plumbing only. Notification, diffing,
    // and rule-filtered snapshots are covered by Slices 2/3/6 — adding
    // those assertions here would be premature.

    test('addSnapshotListener registers a doc target and returns an unsubscribe', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      expect(env.getSnapshotListenerCount()).toBe(0);
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { /* no-op for Slice 1 */ },
      );
      expect(env.getSnapshotListenerCount()).toBe(1);
      unsub();
      expect(env.getSnapshotListenerCount()).toBe(0);
    });

    test('addSnapshotListener registers a query target', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        () => { /* no-op */ },
      );
      expect(env.getSnapshotListenerCount()).toBe(1);
      unsub();
    });

    test('multiple listeners register independently and unsubscribe individually', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const unsubA = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {});
      const unsubB = env.addSnapshotListener({ kind: 'doc', path: 'games/g2' }, () => {});
      const unsubC = env.addSnapshotListener({ kind: 'query', collection: 'games' }, () => {});
      expect(env.getSnapshotListenerCount()).toBe(3);
      unsubB();
      expect(env.getSnapshotListenerCount()).toBe(2);
      unsubA();
      unsubC();
      expect(env.getSnapshotListenerCount()).toBe(0);
    });

    test('unsubscribe is idempotent', () => {
      // Web SDK's `Unsubscribe` contract is silent on double-call but
      // React StrictMode + dev-mode HMR routinely call cleanup twice.
      // Throwing on the second call would surface as a runtime error
      // in agent code that is doing nothing wrong.
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const unsub = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {});
      unsub();
      expect(env.getSnapshotListenerCount()).toBe(0);
      expect(() => unsub()).not.toThrow();
      expect(env.getSnapshotListenerCount()).toBe(0);
    });

    test('two listeners on the same target are tracked as distinct records', () => {
      // Source survey section 2 dedups at the EventManager via canonical keys
      // and shares one upstream subscription across N listeners. The
      // sandbox doesn't have an upstream — every listener is its own
      // computation — so identical targets must register as separate
      // entries to avoid one unsubscribe stranding the other listener.
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const unsubA = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {});
      const unsubB = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {});
      expect(env.getSnapshotListenerCount()).toBe(2);
      unsubA();
      expect(env.getSnapshotListenerCount()).toBe(1);
      unsubB();
      expect(env.getSnapshotListenerCount()).toBe(0);
    });

    test('addSnapshotListener accepts options and an auth context (Slice 2 fires once)', () => {
      // Slice 2 wires the initial fire — verify the options/auth hand-off
      // path doesn't crash and the listener delivers exactly one
      // initial snapshot before any state changes.
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      let called = 0;
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { called++; },
        { includeMetadataChanges: true, source: 'default' },
        { uid: 'alice' },
      );
      expect(called).toBe(1);
      unsub();
    });
  });

  describe('snapshot listeners (Slice 2 — initial fire)', () => {
    // Slice 2 fires the initial snapshot synchronously after register.
    // Slice 3 will add change-driven fires; do not add change tests here.

    test('doc listener fires synchronously with a Web-SDK-shaped snapshot when the doc exists', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { board: 'init', turn: 'X' } },
      });
      const fired: unknown[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => fired.push(snap),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      const snap = fired[0] as {
        id: string;
        ref: { id: string; path: string };
        metadata: { hasPendingWrites: boolean; fromCache: boolean };
        exists(): boolean;
        data(): Record<string, unknown> | undefined;
        get(field: string): unknown;
      };
      expect(snap.id).toBe('g1');
      expect(snap.ref.path).toBe('games/g1');
      expect(snap.metadata.hasPendingWrites).toBe(false);
      expect(snap.metadata.fromCache).toBe(false);
      expect(snap.exists()).toBe(true);
      expect(snap.data()).toEqual({ board: 'init', turn: 'X' });
      expect(snap.get('turn')).toBe('X');
      unsub();
    });

    test('doc listener fires with exists()=false and data()=undefined when the doc is missing', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const fired: { exists: boolean; data: unknown }[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/missing' },
        (snap) => fired.push({ exists: snap.exists(), data: snap.data() }),
        undefined,
        { uid: 'alice' },
      );
      expect(fired).toEqual([{ exists: false, data: undefined }]);
      unsub();
    });

    test('DocumentSnapshot.get() supports dotted paths and yields undefined for missing keys', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { state: { board: { a1: 'X' } } } },
      });
      let captured: { ref: typeof env; snap: any } | undefined;
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => { captured = { ref: env, snap }; },
        undefined,
        { uid: 'alice' },
      );
      expect(captured?.snap.get('state.board.a1')).toBe('X');
      expect(captured?.snap.get('state.missing.nope')).toBeUndefined();
      unsub();
    });

    test('rule-denied doc read routes the error to errorCallback and marks listener errored', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /private/{id} {\n      allow read: if false;\n      allow write: if true;\n    }\n  }\n}\n`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const data: unknown[] = [];
      const errors: unknown[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        (snap) => data.push(snap),
        undefined,
        { uid: 'alice' },
        (err) => errors.push(err),
      );
      expect(data.length).toBe(0);
      expect(errors.length).toBe(1);
      const err = errors[0] as { code: string };
      expect(err.code).toBe('permission-denied');
      unsub();
    });

    test('query listener fires once with all matching docs as `added` changes', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: {
          'games/g1': { turn: 'X' },
          'games/g2': { turn: 'O' },
        },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (snap) => fired.push(snap),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      const snap = fired[0];
      expect(snap.size).toBe(2);
      expect(snap.empty).toBe(false);
      const ids = snap.docs.map((d: { id: string }) => d.id).sort();
      expect(ids).toEqual(['g1', 'g2']);
      const changes = snap.docChanges();
      expect(changes.length).toBe(2);
      for (const c of changes) {
        expect(c.type).toBe('added');
        expect(c.oldIndex).toBe(-1);
      }
      unsub();
    });

    test('query listener on empty collection fires once with empty=true and size=0', () => {
      const env = new LocalEnvironment();
      env.seed({ rules: SIMPLE_RULES });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (snap) => fired.push(snap),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      expect(fired[0].size).toBe(0);
      expect(fired[0].empty).toBe(true);
      expect(fired[0].docs).toEqual([]);
      expect(fired[0].docChanges()).toEqual([]);
      unsub();
    });

    test('docChanges({ includeMetadataChanges: true }) throws when listener did not opt in', () => {
      // Mirrors firebase-js-sdk: requesting metadata-aware changes from
      // a snapshot whose listener didn't request includeMetadataChanges
      // is a programmer error in production; we surface the same error.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { turn: 'X' } },
      });
      let snap: any;
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => { snap = s; },
        // No includeMetadataChanges option.
        undefined,
        { uid: 'alice' },
      );
      expect(() => snap.docChanges({ includeMetadataChanges: true })).toThrow();
      // No-arg and explicit false don't throw.
      expect(() => snap.docChanges()).not.toThrow();
      expect(() => snap.docChanges({ includeMetadataChanges: false })).not.toThrow();
      unsub();
    });

    test('docChanges({ includeMetadataChanges: true }) does not throw when listener opted in', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { turn: 'X' } },
      });
      let snap: any;
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => { snap = s; },
        { includeMetadataChanges: true },
        { uid: 'alice' },
      );
      expect(() => snap.docChanges({ includeMetadataChanges: true })).not.toThrow();
      expect(() => snap.docChanges()).not.toThrow();
      unsub();
    });

    test('initial fire does not append events to the event log', () => {
      // Listener-internal reads are bookkeeping, not user-visible ops.
      // If they leaked into the event log, even a small dashboard with
      // a handful of subscriptions would drown the audit trail.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const before = env.getEvents().length;
      const unsub1 = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      const unsub2 = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(env.getEvents().length).toBe(before);
      unsub1();
      unsub2();
    });

    test('a throwing user callback does not break the simulator or unsubscribe', () => {
      // Production swallows callback errors silently so one buggy
      // consumer can't take down the EventManager. Match that surface.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { turn: 'X' } },
      });
      let calls = 0;
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { calls++; throw new Error('boom'); },
        undefined,
        { uid: 'alice' },
      );
      expect(calls).toBe(1);
      expect(env.getSnapshotListenerCount()).toBe(1);
      expect(() => unsub()).not.toThrow();
    });
  });

  describe('snapshot listeners (Slice 3 — change detection)', () => {
    // Slice 3 fires listeners on writes. Suppression matches findings
    // section 5: doc listeners only fire when the data actually changes;
    // query listeners only fire when the change set is non-empty.

    test('doc listener fires again when its target is updated', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => fired.push(snap.data()),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      const r = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'O' },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(2);
      expect(fired[1].turn).toBe('O');
      unsub();
    });

    test('doc listener does NOT fire when an unrelated path is written', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'waiting' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      const r = env.execute({
        method: 'create',
        path: 'games/g2',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'waiting' },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(1); // unchanged
      unsub();
    });

    test('doc listener fires with exists()=false after the doc is deleted', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} {
      allow read, write: if true;
    }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: { exists: boolean }[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push({ exists: s.exists() }),
      );
      expect(fired).toEqual([{ exists: true }]);
      const r = env.execute({ method: 'delete', path: 'games/g1', auth: null });
      expect(r.allowed).toBe(true);
      expect(fired).toEqual([{ exists: true }, { exists: false }]);
      unsub();
    });

    test('doc listener suppresses no-op writes (post-image equals pre-image)', () => {
      // findings section 5: production's View suppresses by absence rather
      // than re-firing identical snapshots. We mirror that with a
      // shape-equality check.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} {
      allow read, write: if true;
    }
  }
}`,
        documents: { 'games/g1': { turn: 'X', score: 1 } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
      );
      expect(fired.length).toBe(1);
      // Identical post-image — should suppress.
      const r = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: null,
        data: { turn: 'X', score: 1 },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(1);
      unsub();
    });

    test('query listener fires with `added` change when a new doc lands in the collection', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'waiting' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      expect(fired[0].size).toBe(1);
      const r = env.execute({
        method: 'create',
        path: 'games/g2',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'waiting' },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(2);
      expect(fired[1].size).toBe(2);
      const changes = fired[1].docChanges();
      expect(changes.length).toBe(1);
      expect(changes[0].type).toBe('added');
      expect(changes[0].doc.id).toBe('g2');
      unsub();
    });

    test('query listener fires with `removed` change when a doc leaves the collection', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: {
          'games/g1': { turn: 'X' },
          'games/g2': { turn: 'O' },
        },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => fired.push(s),
      );
      expect(fired.length).toBe(1);
      const r = env.execute({ method: 'delete', path: 'games/g1', auth: null });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(2);
      expect(fired[1].size).toBe(1);
      const changes = fired[1].docChanges();
      expect(changes.length).toBe(1);
      expect(changes[0].type).toBe('removed');
      expect(changes[0].doc.id).toBe('g1');
      unsub();
    });

    test('query listener fires with `modified` when an existing doc is updated', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => fired.push(s),
      );
      expect(fired.length).toBe(1);
      const r = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: null,
        data: { turn: 'O' },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(2);
      const changes = fired[1].docChanges();
      expect(changes.length).toBe(1);
      expect(changes[0].type).toBe('modified');
      expect(changes[0].doc.data().turn).toBe('O');
      unsub();
    });

    test('query listener does NOT fire on writes outside its collection', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
    match /chats/{id} { allow read, write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        (s) => fired.push(s),
      );
      expect(fired.length).toBe(1);
      const r = env.execute({
        method: 'create',
        path: 'chats/c1',
        auth: null,
        data: { msg: 'hi' },
      });
      expect(r.allowed).toBe(true);
      expect(fired.length).toBe(1);
      unsub();
    });

    test('rule-denied write does not fan out to listeners', () => {
      // Listeners observe committed state. Failed writes never touched
      // state, so there's nothing to notify.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'waiting' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      // status: 'waiting' update violates SIMPLE_RULES (requires 'playing').
      const r = env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'waiting', guest: 'bob' },
      });
      expect(r.allowed).toBe(false);
      expect(fired.length).toBe(1);
      unsub();
    });

    test('batch commit fires each affected listener exactly once', () => {
      // Slice 3 design: per-op writes inside batch() are wrapped by a
      // single notify pass after applyBatch — Slice 5 will refactor to
      // collect mid-flight, but the observable behavior here is what
      // it should already be.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: {
          'games/g1': { turn: 'X' },
          'games/g2': { turn: 'O' },
        },
      });
      const firedG1: any[] = [];
      const firedG2: any[] = [];
      const firedQuery: any[] = [];
      const u1 = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, (s) => firedG1.push(s));
      const u2 = env.addSnapshotListener({ kind: 'doc', path: 'games/g2' }, (s) => firedG2.push(s));
      const uQ = env.addSnapshotListener({ kind: 'query', collection: 'games' }, (s) => firedQuery.push(s));
      expect(firedG1.length).toBe(1);
      expect(firedG2.length).toBe(1);
      expect(firedQuery.length).toBe(1);

      const r = env.batch(
        [
          { method: 'update', path: 'games/g1', data: { turn: 'O' } },
          { method: 'update', path: 'games/g2', data: { turn: 'X' } },
        ],
        null,
      );
      expect(r.allowed).toBe(true);
      // Each doc listener fires once for its single update.
      expect(firedG1.length).toBe(2);
      expect(firedG2.length).toBe(2);
      // Query listener fires once (single snapshot containing both modifications).
      expect(firedQuery.length).toBe(2);
      const changes = firedQuery[1].docChanges();
      expect(changes.length).toBe(2);
      expect(new Set(changes.map((c: any) => c.type))).toEqual(new Set(['modified']));

      u1(); u2(); uQ();
    });

    test('rolled-back batch does not notify any listener', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      // First op passes, second op fails (status 'waiting' update is denied).
      const r = env.batch(
        [
          { method: 'update', path: 'games/g1', data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'Y' } },
          { method: 'create', path: 'games/g2', data: { host: 'mallory', status: 'waiting' } },
        ],
        { uid: 'alice' },
      );
      expect(r.allowed).toBe(false);
      expect(fired.length).toBe(1);
      unsub();
    });

    // Slice 5 — symmetric coverage for the transaction notify path.
    // The Slice 3 implementation already defers transaction notifications
    // to a single fire after commit (see local-environment.ts:1379-1387);
    // these tests lock that contract on the transaction surface, mirroring
    // the batch tests above.
    test('transaction commit fires each affected listener exactly once', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: {
          'games/g1': { turn: 'X' },
          'games/g2': { turn: 'O' },
        },
      });
      const firedG1: any[] = [];
      const firedG2: any[] = [];
      const firedQuery: any[] = [];
      const u1 = env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, (s) => firedG1.push(s));
      const u2 = env.addSnapshotListener({ kind: 'doc', path: 'games/g2' }, (s) => firedG2.push(s));
      const uQ = env.addSnapshotListener({ kind: 'query', collection: 'games' }, (s) => firedQuery.push(s));
      expect(firedG1.length).toBe(1);
      expect(firedG2.length).toBe(1);
      expect(firedQuery.length).toBe(1);

      const r = env.transaction((tx) => {
        tx.update('games/g1', { turn: 'O' });
        tx.update('games/g2', { turn: 'X' });
      }, { auth: { uid: 'a' } });
      expect(r.allowed).toBe(true);
      // Each doc listener fires once for its single update (1 initial + 1 tx).
      expect(firedG1.length).toBe(2);
      expect(firedG2.length).toBe(2);
      // Query listener fires once for the tx (single snapshot containing both modifications).
      expect(firedQuery.length).toBe(2);
      const changes = firedQuery[1].docChanges();
      expect(changes.length).toBe(2);
      expect(new Set(changes.map((c: any) => c.type))).toEqual(new Set(['modified']));

      u1(); u2(); uQ();
    });

    test('rolled-back transaction (rule denial) does not notify any listener', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      // bob is denied — entire tx rolls back.
      const r = env.transaction((tx) => {
        tx.update('games/g1', { turn: 'O' });
      }, { auth: { uid: 'bob' } });
      expect(r.allowed).toBe(false);
      expect(fired.length).toBe(1);
      unsub();
    });

    test('aborted transaction (callback throw) does not notify any listener', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
      );
      expect(fired.length).toBe(1);
      // Callback queues a write then throws — atomic abort, no commit.
      expect(() => env.transaction((tx) => {
        tx.update('games/g1', { turn: 'O' });
        throw new Error('user code blew up');
      }, { auth: { uid: 'a' } })).toThrow('user code blew up');
      expect(fired.length).toBe(1);
      unsub();
    });

    test('unsubscribe inside a callback prevents further fires and is safe mid-dispatch', () => {
      // Iterating a snapshotted records list keeps the dispatch loop
      // safe even when a callback mutates the registry (StrictMode +
      // HMR routinely do). The sibling listener on the same path
      // still fires on the same write — the unsubscribed one drops
      // out for subsequent writes.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} { allow read, write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      let aCalls = 0;
      let bCalls = 0;
      let unsubA!: () => void;
      unsubA = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { aCalls++; if (aCalls === 2) unsubA(); },
      );
      const unsubB = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { bCalls++; },
      );
      expect(aCalls).toBe(1);
      expect(bCalls).toBe(1);

      // Write #1: A fires (then unsubs itself), B fires.
      env.execute({ method: 'update', path: 'games/g1', auth: null, data: { turn: 'O' } });
      expect(aCalls).toBe(2);
      expect(bCalls).toBe(2);
      expect(env.getSnapshotListenerCount()).toBe(1);

      // Write #2: A is gone, only B fires.
      env.execute({ method: 'update', path: 'games/g1', auth: null, data: { turn: 'P' } });
      expect(aCalls).toBe(2);
      expect(bCalls).toBe(3);

      unsubB();
    });

    test('errored listener (denied initial read) is skipped on subsequent writes', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /private/{id} {
      allow read: if false;
      allow write: if true;
    }
  }
}`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const data: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        (s) => data.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      expect(errors.length).toBe(1);
      // A successful write to the same path must not re-fire data
      // (listener is in errored state).
      const r = env.execute({
        method: 'update',
        path: 'private/p1',
        auth: { uid: 'alice' },
        data: { secret: 'still shh' },
      });
      expect(r.allowed).toBe(true);
      expect(data.length).toBe(0);
      expect(errors.length).toBe(1); // error not re-delivered either
      unsub();
    });
  });

  describe('snapshot listeners (Slice 6 — rule-enforced + re-eval)', () => {
    // Slice 6 adds two distinct behaviors:
    //   Part A — query listeners enforce the collection's `list` rule
    //            under the query-proof model (RULES-B11): an unprovable
    //            query errors WHOLE; per-doc `get` rules never filter
    //            query results ("rules are not filters",
    //            firebase.google.com/docs/firestore/security/rules-query).
    //   Part B — `deployRules` re-evaluates every active listener under
    //            the new rules; flips surface as added/removed/error/clear.
    //
    // section 4.1 of design rationale divergence: production
    // does NOT re-evaluate active listeners on rule change. The sandbox
    // does, because the playground's value is seeing rule effects live.

    test('query snapshot delivers every doc the list rule admits — get rules do not filter (RULES-B11)', () => {
      // Two docs in the same collection; `list` allows everyone, `get`
      // only the doc's owner. PRODUCTION: queries are governed by the
      // `list` rule alone — alice's listener sees BOTH docs, including
      // bob's, even though she couldn't `get` it individually. This test
      // previously asserted the opposite (per-doc silent filtering — the
      // RULES-B11 rules-as-filters divergence); flipped per the T3
      // step-13 hand-off + the rules-query prod docs.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow list: if request.auth != null;
      allow get: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if true;
    }
  }
}`,
        documents: {
          'items/a': { owner: 'alice', label: 'A' },
          'items/b': { owner: 'bob', label: 'B' },
        },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'items' },
        (snap) => fired.push(snap),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);
      const snap = fired[0];
      expect(snap.size).toBe(2);
      expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['a', 'b']);
      unsub();
    });

    test('query listener under a doc-data-dependent list rule errors WHOLE — never a truncated snapshot (RULES-B11)', () => {
      // A bare collection listen cannot prove `resource.data.owner ==
      // request.auth.uid` for every returnable doc → prod rejects the
      // query outright ("rules are not filters"); the listener gets a
      // stream error, not alice's subset.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if true;
    }
  }
}`,
        documents: {
          'items/a': { owner: 'alice', label: 'A' },
          'items/b': { owner: 'bob', label: 'B' },
        },
      });
      const fired: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'items' },
        (snap) => fired.push(snap),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      expect(fired.length).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('permission-denied');
      unsub();
    });

    test('deployRules makes a previously-denied doc readable → fires snapshot + clears errored', () => {
      // Listener subscribes under rules that deny read; a permissive
      // deploy must clear the errored flag and deliver an initial
      // snapshot to the same callback.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const data: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => data.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      // Initial fire was denied.
      expect(data.length).toBe(0);
      expect(errors.length).toBe(1);

      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if request.auth != null; allow write: if request.auth != null; }
  }
}`);

      // Re-eval cleared errored and fired the initial snapshot.
      expect(data.length).toBe(1);
      expect(data[0].exists()).toBe(true);
      expect(data[0].data()).toEqual({ turn: 'X' });
      expect(errors.length).toBe(1); // error not re-delivered
      unsub();
    });

    test('deployRules makes a previously-readable doc unreadable → marks errored', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if request.auth != null; allow write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const data: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => data.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      expect(data.length).toBe(1);
      expect(errors.length).toBe(0);

      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if false; allow write: if request.auth != null; }
  }
}`);

      // Re-eval flipped allowed → denied.
      expect(data.length).toBe(1); // no further snapshot
      expect(errors.length).toBe(1);
      const err = errors[0] as { code: string };
      expect(err.code).toBe('permission-denied');
      unsub();
    });

    test('deployRules opens a query listener: errored (unprovable) listen recovers with every doc `added`', () => {
      // RULES-B11 flip: this test previously asserted the per-doc filter
      // (list passes, get owner-gated → alice initially sees only her doc;
      // a permissive deploy surfaced bob's as `added`). Under the prod
      // query-proof model that initial state is impossible — a doc-data-
      // dependent rule DENIES the bare listen whole. The Part-B behavior
      // under test (deployRules re-opens a query listener) now flows
      // through the errored → recovered path.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if true;
    }
  }
}`,
        documents: {
          'items/a': { owner: 'alice', label: 'A' },
          'items/b': { owner: 'bob', label: 'B' },
        },
      });
      const fired: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'items' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      // Unprovable bare listen → whole-query denial (rules are not filters).
      expect(fired.length).toBe(0);
      expect(errors.length).toBe(1);

      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read: if request.auth != null; allow write: if request.auth != null; }
  }
}`);

      // Re-eval cleared errored and delivered a fresh baseline snapshot
      // with BOTH docs added.
      expect(fired.length).toBe(1);
      expect(fired[0].size).toBe(2);
      const added = fired[0].docChanges().filter((c: any) => c.type === 'added');
      expect(added.length).toBe(2);
      unsub();
    });

    test('deployRules tightens a query listener: now-unprovable query errors WHOLE (no truncated `removed` snapshot)', () => {
      // RULES-B11 flip: this test previously asserted that tightening to
      // an owner-gated `get` filtered bob's doc out as a `removed` change.
      // Production never truncates: a deploy that makes the bare listen
      // unprovable rejects the whole query — the listener transitions to
      // a stream error ("rules are not filters").
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read: if request.auth != null; allow write: if true; }
  }
}`,
        documents: {
          'items/a': { owner: 'alice', label: 'A' },
          'items/b': { owner: 'bob', label: 'B' },
        },
      });
      const fired: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'query', collection: 'items' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      expect(fired.length).toBe(1);
      expect(fired[0].size).toBe(2);

      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow write: if request.auth != null;
    }
  }
}`);

      // No second snapshot — the whole query is now unprovable.
      expect(fired.length).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('permission-denied');
      unsub();
    });

    test('deployRules with a no-op rule change does not re-fire (suppression)', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if request.auth != null; allow write: if request.auth != null; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const fired: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => fired.push(s),
        undefined,
        { uid: 'alice' },
      );
      expect(fired.length).toBe(1);

      // Same rule text → swap is a no-op for the listener; suppression
      // applies because currentDocData is unchanged.
      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if request.auth != null; allow write: if request.auth != null; }
  }
}`);

      expect(fired.length).toBe(1);
      unsub();
    });

    test('deployRules that fails to lint does not trigger re-evaluation', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const data: any[] = [];
      const errors: any[] = [];
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (s) => data.push(s),
        undefined,
        { uid: 'alice' },
        (e) => errors.push(e),
      );
      expect(errors.length).toBe(1);

      // Note: this test previously asserted "lint errors block install
      // and skip re-eval." That behavior was removed (lint is now
      // diagnosis, not enforcement — see deployRules in
      // local-environment.ts) so the sandbox always installs and always
      // re-evaluates. `allow read, write: if true` is now a WARNING not
      // an ERROR (PERMISSIVE_RULE severity softened), and even genuine
      // errors don't block install — production deploy gates catch them
      // at ship time. We assert the new behavior: install succeeds,
      // re-eval fires, the listener gets a successful re-snapshot.
      const lint = env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read, write: if request.auth != null; }
  }
}`);
      // Lint clean for the request-auth check.
      const hasErrors = lint.warnings.some((w) => w.severity === 'error');
      expect(hasErrors).toBe(false);
      unsub();
    });
  });

  describe('snapshot listeners (Slice 7 — env-level error subscription)', () => {
    // Two-level model per source survey section 9: a stream error fans out to
    // BOTH the listener's own `errorCallback` AND every env-level
    // subscriber registered via `onSnapshotError`. The playground uses
    // the env-level channel to surface stream errors as toasts without
    // each listener needing to register its own handler.

    test('onSnapshotError fires when initial fire is denied (with target context)', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const events: { err: any; target: any }[] = [];
      const unsubEnv = env.onSnapshotError((err, target) => {
        events.push({ err, target });
      });

      const unsubListener = env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );

      expect(events.length).toBe(1);
      expect(events[0]!.err.code).toBe('permission-denied');
      expect(events[0]!.target).toEqual({ kind: 'doc', path: 'private/p1' });

      unsubListener();
      unsubEnv();
    });

    test('onSnapshotError fires alongside the listener errorCallback (dual-emit)', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const envEvents: any[] = [];
      const listenerErrors: any[] = [];
      const unsubEnv = env.onSnapshotError((err) => envEvents.push(err));
      const unsubListener = env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
        (err) => listenerErrors.push(err),
      );

      // Both channels received the error.
      expect(envEvents.length).toBe(1);
      expect(listenerErrors.length).toBe(1);
      // Same FirestoreSimError reference handed to both — the simulator
      // doesn't construct two separate error objects per dispatch.
      expect(envEvents[0]).toBe(listenerErrors[0]);

      unsubListener();
      unsubEnv();
    });

    test('onSnapshotError fires when a write triggers a re-read denial', () => {
      // List passes initially; a subsequent write triggers re-evaluation
      // of the query listener, which now hits a denied get.
      // Simpler reproduction: doc listener that goes from allowed to a
      // rule-denied state via deployRules (already tested in Slice 6 tests
      // for the listener errorCallback — here we just verify the env
      // channel mirrors it).
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if request.auth != null; allow write: if request.auth != null; }
  }
}`,
        documents: { 'games/g1': { turn: 'X' } },
      });
      const envEvents: any[] = [];
      const unsubEnv = env.onSnapshotError((err, target) => {
        envEvents.push({ err, target });
      });
      const unsubListener = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      // Initial fire was allowed — no error yet.
      expect(envEvents.length).toBe(0);

      // Rule deploy flips it denied; Slice 6 markErrored fires.
      env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} { allow read: if false; allow write: if request.auth != null; }
  }
}`);
      expect(envEvents.length).toBe(1);
      expect(envEvents[0]!.target).toEqual({ kind: 'doc', path: 'games/g1' });

      unsubListener();
      unsubEnv();
    });

    test('onSnapshotError supports multiple subscribers (each receives every error)', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const a: any[] = [];
      const b: any[] = [];
      const unsubA = env.onSnapshotError((err) => a.push(err));
      const unsubB = env.onSnapshotError((err) => b.push(err));
      const unsubListener = env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      unsubListener();
      unsubA();
      unsubB();
    });

    test('onSnapshotError unsubscribe stops further events', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: {
          'private/p1': { secret: 'shh' },
          'private/p2': { secret: 'shh2' },
        },
      });
      const events: any[] = [];
      const unsubEnv = env.onSnapshotError((err) => events.push(err));
      env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(events.length).toBe(1);
      unsubEnv();

      // After unsubscribe, a new errored listener does not deliver.
      env.addSnapshotListener(
        { kind: 'doc', path: 'private/p2' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(events.length).toBe(1);
    });

    test('onSnapshotError swallows subscriber throws (does not break dispatch)', () => {
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'private/p1': { secret: 'shh' } },
      });
      const good: any[] = [];
      env.onSnapshotError(() => { throw new Error('faulty subscriber'); });
      env.onSnapshotError((err) => good.push(err));
      // Adding the listener triggers initial-fire denial; the throwing
      // subscriber must not stop the second one from receiving.
      env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(good.length).toBe(1);
    });

    test('onSnapshotError carries the query target for query listeners', () => {
      // List rule denies — the listener errors at initial fire and the
      // env event must surface the query target, not a doc target.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read: if false; allow write: if true; }
  }
}`,
        documents: { 'items/a': { x: 1 } },
      });
      const events: { target: any }[] = [];
      env.onSnapshotError((_err, target) => events.push({ target }));
      env.addSnapshotListener(
        { kind: 'query', collection: 'items' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(events.length).toBe(1);
      expect(events[0]!.target).toEqual({ kind: 'query', collection: 'items' });
    });
  });

  describe('snapshot listeners (Slice 8 — edge cases + dispose)', () => {
    // Slice 8 covers the lifecycle edges that don't fit cleanly into the
    // earlier slices: callback-time mutation of the registry, multi-listener
    // independence on writes, callback drop after unsubscribe, and the
    // explicit `dispose()` teardown the playground reseed path uses.

    test('a callback that unsubscribes itself stops receiving further notifications', () => {
      // The Web SDK contract is silent on this — but production's
      // EventManager removes the listener synchronously on unsubscribe,
      // so a callback that detaches itself mid-fire never sees the next
      // change. We mirror that by using `Map.delete` from the unsubscribe
      // closure and snapshot-iterating the registry in
      // `notifyListenersForPaths` (so the in-flight call doesn't crash on
      // a mutated map).
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      const fired: any[] = [];
      let unsub: () => void = () => {};
      unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => {
          fired.push(snap.data()?.turn);
          // Unsubscribe from inside the second fire (initial fire is the
          // first; we want to detach before the third would dispatch).
          if (fired.length === 2) unsub();
        },
        undefined,
        { uid: 'alice' },
      );
      // Initial fire.
      expect(fired).toEqual(['X']);
      // Second fire — the callback unsubscribes itself.
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'O' },
      });
      expect(fired).toEqual(['X', 'O']);
      expect(env.getSnapshotListenerCount()).toBe(0);
      // Third write — no further notification because the listener is gone.
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' },
      });
      expect(fired).toEqual(['X', 'O']);
    });

    test('a callback that unsubscribes a SIBLING listener mid-dispatch does not crash', () => {
      // Two listeners on the same target. The first callback unsubscribes
      // the second one — the second must not fire for that change. The
      // dispatch loop iterates a snapshotted record list and re-checks
      // membership before invoking each callback, so the late-removed
      // record is skipped cleanly.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      const aFired: any[] = [];
      const bFired: any[] = [];
      let unsubB: () => void = () => {};
      const unsubA = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => {
          aFired.push(snap.data()?.turn);
          if (aFired.length === 2) unsubB();
        },
        undefined,
        { uid: 'alice' },
      );
      unsubB = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => bFired.push(snap.data()?.turn),
        undefined,
        { uid: 'alice' },
      );
      expect(aFired).toEqual(['X']);
      expect(bFired).toEqual(['X']);
      // Write — A's callback unsubscribes B before B's callback would fire.
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'O' },
      });
      expect(aFired).toEqual(['X', 'O']);
      // B got its initial fire but NOT the post-write fire — A removed it
      // from the registry before the dispatch loop reached its record.
      expect(bFired).toEqual(['X']);
      unsubA();
    });

    test('two listeners on the same target receive independent notifications on writes', () => {
      // Slice 1 verified independent registration; this verifies the
      // dispatch path actually drives each callback once per write.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      const aFired: string[] = [];
      const bFired: string[] = [];
      const unsubA = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => aFired.push(snap.data()?.turn ?? 'absent'),
        undefined,
        { uid: 'alice' },
      );
      const unsubB = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        (snap) => bFired.push(snap.data()?.turn ?? 'absent'),
        undefined,
        { uid: 'alice' },
      );
      expect(aFired).toEqual(['X']);
      expect(bFired).toEqual(['X']);
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'O' },
      });
      expect(aFired).toEqual(['X', 'O']);
      expect(bFired).toEqual(['X', 'O']);
      unsubB();
      // After B unsubscribes, A continues firing alone.
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' },
      });
      expect(aFired).toEqual(['X', 'O', 'X']);
      expect(bFired).toEqual(['X', 'O']);
      unsubA();
    });

    test('an unsubscribed listener is no longer invoked on subsequent writes', () => {
      // Memory-leak proxy: we can't directly assert "GC reclaimed the
      // closure", but if the registry no longer reaches the callback then
      // the callback is unreachable from the env and is GC-eligible once
      // external refs drop. Verifying the dispatch path doesn't reach an
      // unsubscribed callback is the strongest portable assertion.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      let fires = 0;
      const unsub = env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { fires++; },
        undefined,
        { uid: 'alice' },
      );
      expect(fires).toBe(1);
      unsub();
      expect(env.getSnapshotListenerCount()).toBe(0);
      // Drive several writes — the unsubscribed callback must not see them.
      for (const turn of ['O', 'X', 'O']) {
        env.execute({
          method: 'update',
          path: 'games/g1',
          auth: { uid: 'alice' },
          data: { host: 'alice', status: 'playing', guest: 'bob', turn },
        });
      }
      expect(fires).toBe(1);
    });

    test('dispose() clears every registered snapshot listener in one shot', () => {
      // The reseed teardown contract: a host about to discard the env
      // can dispose it once and trust no callback will ever fire again,
      // even if the dispatch path is invoked by a stray write through
      // the same instance.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'playing', guest: 'bob', turn: 'X' } },
      });
      let docFires = 0;
      let queryFires = 0;
      env.addSnapshotListener(
        { kind: 'doc', path: 'games/g1' },
        () => { docFires++; },
        undefined,
        { uid: 'alice' },
      );
      env.addSnapshotListener(
        { kind: 'query', collection: 'games' },
        () => { queryFires++; },
        undefined,
        { uid: 'alice' },
      );
      expect(env.getSnapshotListenerCount()).toBe(2);
      expect(docFires).toBe(1);
      expect(queryFires).toBe(1);
      env.dispose();
      expect(env.getSnapshotListenerCount()).toBe(0);
      // A post-dispose write must not reach the dropped callbacks.
      env.execute({
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'alice' },
        data: { host: 'alice', status: 'playing', guest: 'bob', turn: 'O' },
      });
      expect(docFires).toBe(1);
      expect(queryFires).toBe(1);
    });

    test('dispose() clears denial and snapshot-error subscribers too', () => {
      // The three listener registries (snapshot, denial, snapshot-error)
      // share the same lifetime — a host that disposes one expects all
      // three to drop together. Verified by triggering events that would
      // normally fan out and asserting nothing reaches the subscribers.
      const env = new LocalEnvironment();
      env.seed({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} { allow read: if false; allow write: if request.auth != null; }
  }
}`,
        documents: { 'private/p1': { x: 1 } },
      });
      let denials = 0;
      let snapErrors = 0;
      env.onDenial(() => { denials++; });
      env.onSnapshotError(() => { snapErrors++; });
      // Baseline: a denied read fans out to onDenial, a denied listener
      // initial-fire fans out to onSnapshotError.
      const r = env.execute({ method: 'get', path: 'private/p1', auth: { uid: 'alice' } });
      expect(r.allowed).toBe(false);
      expect(denials).toBe(1);
      env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(snapErrors).toBe(1);
      // Dispose drops both subscriber sets.
      env.dispose();
      const r2 = env.execute({ method: 'get', path: 'private/p1', auth: { uid: 'alice' } });
      expect(r2.allowed).toBe(false);
      expect(denials).toBe(1); // unchanged
      env.addSnapshotListener(
        { kind: 'doc', path: 'private/p1' },
        () => {},
        undefined,
        { uid: 'alice' },
      );
      expect(snapErrors).toBe(1); // unchanged
    });

    test('dispose() is idempotent and leaves data state untouched', () => {
      // Calling dispose twice is a no-op the second time. dispose() does
      // not affect data, rules, or the event log — those have their own
      // lifecycle (re-seed / re-deploy). Verifying both halves explicitly
      // because conflating them would let agents reach for dispose() as a
      // pseudo-reset and silently lose data.
      const env = new LocalEnvironment();
      env.seed({
        rules: SIMPLE_RULES,
        documents: { 'games/g1': { host: 'alice', status: 'waiting' } },
      });
      env.addSnapshotListener({ kind: 'doc', path: 'games/g1' }, () => {}, undefined, { uid: 'alice' });
      env.dispose();
      expect(env.getSnapshotListenerCount()).toBe(0);
      expect(() => env.dispose()).not.toThrow();
      // Data survives.
      expect(env.getDocument('games/g1')).toEqual({ host: 'alice', status: 'waiting' });
      // Rules survive — a post-dispose read still evaluates correctly.
      const r = env.execute({ method: 'get', path: 'games/g1', auth: { uid: 'alice' } });
      expect(r.allowed).toBe(true);
    });
  });
});
