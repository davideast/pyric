/**
 * Bug bash: LocalEnvironment
 *
 * Throws real-world multi-step workflows, edge cases, and adversarial
 * scenarios at the local environment to find bugs.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_RULE_FIXTURES = join(__dirname, '../../../fixtures/firestore-game-rules');

// ═══ Full chess game session ═══

describe('Chess game session', () => {
  const CHESS_RULES = readFileSync(join(GAME_RULE_FIXTURES, 'chess.rules'), 'utf-8');
  const CHESS_CONFIG = JSON.parse(readFileSync(join(GAME_RULE_FIXTURES, 'chess-config.json'), 'utf-8'));

  function emptyBoard(): Record<string, string> {
    const b: Record<string, string> = {};
    for (const f of 'abcdefgh') for (const r of '12345678') b[f + r] = '';
    return b;
  }

  const EMPTY_POS: Record<string, string> = {};
  for (const p of ['hp_K','hp_Q','hp_R1','hp_R2','hp_B1','hp_B2','hp_N1','hp_N2',
    'hp_P1','hp_P2','hp_P3','hp_P4','hp_P5','hp_P6','hp_P7','hp_P8',
    'gp_k','gp_q','gp_r1','gp_r2','gp_b1','gp_b2','gp_n1','gp_n2',
    'gp_p1','gp_p2','gp_p3','gp_p4','gp_p5','gp_p6','gp_p7','gp_p8']) {
    EMPTY_POS[p] = '';
  }

  function chessGame(ov: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...emptyBoard(), ...EMPTY_POS,
      host: 'white', guest: 'black',
      status: 'playing', currentTurn: 'host',
      moveCount: 0, moveFrom: '', moveTo: '',
      movedPiece: '', capturedPiece: '', moveType: '', promotedTo: '',
      lastDoublePawn: '',
      hp_K_moved: false, hp_R1_moved: false, hp_R2_moved: false,
      gp_k_moved: false, gp_r1_moved: false, gp_r2_moved: false,
      ...ov,
    };
  }

  test('knight move → undo → redo → state is consistent', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: CHESS_RULES,
      documents: {
        'gameConfig/chess': CHESS_CONFIG,
        'chess/g1': chessGame({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
      },
    });

    // Move knight
    const r = env.execute({
      method: 'update', path: 'chess/g1', auth: { uid: 'white' },
      data: chessGame({
        e1: 'K', hp_K: 'e1', b1: '', c3: 'N', hp_N1: 'c3', e8: 'k', gp_k: 'e8',
        moveFrom: 'b1', moveTo: 'c3', movedPiece: 'hp_N1', moveType: 'normal',
        moveCount: 1, currentTurn: 'guest',
      }),
    });

    expect(r.allowed).toBe(true);
    expect(env.getDocument('chess/g1')!.c3).toBe('N');
    expect(env.getDocument('chess/g1')!.b1).toBe('');

    // Undo
    env.undo();
    expect(env.getDocument('chess/g1')!.c3).toBe('');
    expect(env.getDocument('chess/g1')!.b1).toBe('N');

    // Redo
    env.redo();
    expect(env.getDocument('chess/g1')!.c3).toBe('N');
    expect(env.getDocument('chess/g1')!.b1).toBe('');
  });

  test('invalid move denied, state unchanged', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: CHESS_RULES,
      documents: {
        'gameConfig/chess': CHESS_CONFIG,
        'chess/g1': chessGame({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
      },
    });

    const r = env.execute({
      method: 'update', path: 'chess/g1', auth: { uid: 'white' },
      data: chessGame({
        e1: 'K', hp_K: 'e1', b1: '', b3: 'N', hp_N1: 'b3', e8: 'k', gp_k: 'e8',
        moveFrom: 'b1', moveTo: 'b3', movedPiece: 'hp_N1', moveType: 'normal',
        moveCount: 1, currentTurn: 'guest',
      }),
    });

    expect(r.allowed).toBe(false);
    expect(env.getDocument('chess/g1')!.b1).toBe('N'); // unchanged
  });
});

// ═══ Lobby lifecycle ═══

describe('Lobby lifecycle', () => {
  const LOBBY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      allow create: if request.auth != null
          && request.resource.data.host == request.auth.uid
          && request.resource.data.guest == ''
          && request.resource.data.status == 'waiting';

      allow update: if request.auth != null
          && resource.data.status == 'waiting'
          && resource.data.guest == ''
          && request.resource.data.guest == request.auth.uid
          && request.auth.uid != resource.data.host
          && request.resource.data.status == 'playing'
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['guest', 'status']);

      allow delete: if request.auth != null
          && resource.data.status == 'waiting'
          && request.auth.uid == resource.data.host;
    }
  }
}`;

  test('create → join → verify state after each step', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: LOBBY_RULES });

    // Host creates game
    const c = env.execute({
      method: 'create', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: '', status: 'waiting' },
    });
    expect(c.allowed).toBe(true);
    expect(env.getDocument('games/g1')!.status).toBe('waiting');

    // Guest joins
    const j = env.execute({
      method: 'update', path: 'games/g1', auth: { uid: 'bob' },
      data: { host: 'alice', guest: 'bob', status: 'playing' },
    });
    expect(j.allowed).toBe(true);
    expect(env.getDocument('games/g1')!.guest).toBe('bob');
    expect(env.getDocument('games/g1')!.status).toBe('playing');
  });

  test('host cannot join own game', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: LOBBY_RULES });

    env.execute({
      method: 'create', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: '', status: 'waiting' },
    });

    const j = env.execute({
      method: 'update', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: 'alice', status: 'playing' },
    });
    expect(j.allowed).toBe(false);
    expect(env.getDocument('games/g1')!.guest).toBe('');
  });

  test('undo join reverts to waiting', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: LOBBY_RULES });

    env.execute({
      method: 'create', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: '', status: 'waiting' },
    });

    env.execute({
      method: 'update', path: 'games/g1', auth: { uid: 'bob' },
      data: { host: 'alice', guest: 'bob', status: 'playing' },
    });

    expect(env.getDocument('games/g1')!.status).toBe('playing');
    env.undo();
    expect(env.getDocument('games/g1')!.status).toBe('waiting');
    expect(env.getDocument('games/g1')!.guest).toBe('');
  });

  test('undo create removes the game', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: LOBBY_RULES });

    env.execute({
      method: 'create', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: '', status: 'waiting' },
    });

    expect(env.getDocument('games/g1')).not.toBe(null);
    env.undo();
    expect(env.getDocument('games/g1')).toBe(null);
  });

  test('delete then undo restores game', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: LOBBY_RULES });

    env.execute({
      method: 'create', path: 'games/g1', auth: { uid: 'alice' },
      data: { host: 'alice', guest: '', status: 'waiting' },
    });

    env.execute({
      method: 'delete', path: 'games/g1', auth: { uid: 'alice' },
    });

    expect(env.getDocument('games/g1')).toBe(null);
    env.undo(); // undo delete
    expect(env.getDocument('games/g1')).not.toBe(null);
    expect(env.getDocument('games/g1')!.host).toBe('alice');
  });
});

// ═══ Multiple undo/redo stress ═══

describe('undo/redo stress', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /counters/{id} {
      allow create, update: if request.auth != null;
    }
  }
}`;

  test('10 operations → undo all → redo all', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES });

    // Create and increment 10 times
    env.execute({ method: 'create', path: 'counters/c1', auth: { uid: 'u1' }, data: { value: 0 } });
    for (let i = 1; i <= 9; i++) {
      env.execute({ method: 'update', path: 'counters/c1', auth: { uid: 'u1' }, data: { value: i } });
    }
    expect(env.getDocument('counters/c1')!.value).toBe(9);

    // Undo all 10
    for (let i = 0; i < 10; i++) env.undo();
    expect(env.getDocument('counters/c1')).toBe(null); // fully reverted

    // Redo all 10
    for (let i = 0; i < 10; i++) env.redo();
    expect(env.getDocument('counters/c1')!.value).toBe(9);
  });

  test('undo past denied operations (only undoes writes)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.auth != null;
      allow update: if request.auth != null && request.resource.data.value > resource.data.value;
    }
  }
}`,
    });

    env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { value: 5 } });
    env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { value: 3 } }); // DENIED (3 < 5)
    env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { value: 10 } }); // ALLOWED

    expect(env.getDocument('test/d1')!.value).toBe(10);
    expect(env.getEventCount()).toBe(3); // all 3 logged

    env.undo(); // undo the value=10 update
    expect(env.getDocument('test/d1')!.value).toBe(5); // back to create state, not the denied state

    env.undo(); // undo the create
    expect(env.getDocument('test/d1')).toBe(null);
  });
});

// ═══ Deploy rules mid-session ═══

describe('deploy rules mid-session', () => {
  test('state persists across rule changes', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow create: if request.auth != null; allow update: if false; }
  }
}`,
    });

    env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 1 } });
    expect(env.getDocument('test/d1')!.x).toBe(1);

    // Update denied under current rules
    const r1 = env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 2 } });
    expect(r1.allowed).toBe(false);

    // Deploy permissive rules
    env.deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow create, update: if request.auth != null; }
  }
}`);

    // Same update now allowed
    const r2 = env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 2 } });
    expect(r2.allowed).toBe(true);
    expect(env.getDocument('test/d1')!.x).toBe(2);
  });

  test('lint errors block rule deployment', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow read: if true; }
  }
}` });

    // Try to deploy rules with 12 let bindings (over limit)
    const lets = Array.from({ length: 12 }, (_, i) => `        let v${i} = request.resource.data.f${i};`).join('\n');
    const badRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      function check() {
${lets}
        return v0 != '' && v1 != '';
      }
      allow update: if check();
    }
  }
}`;

    const lint = env.deployRules(badRules);
    const errors = lint.warnings.filter(w => w.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);

    // Lint is diagnosis, not enforcement — the sandbox installs whatever
    // the caller asks for so the dev loop never silently no-ops (the
    // CLAUDE_DEBUG_SESSION.md failure mode). Production deploy gates
    // (pyric deploy rules) catch lint errors at ship time. So the
    // installed source DOES include `check()` here; what we care about
    // is that the LintResult surfaced the problem to the caller.
    expect(env.getRules()).toContain('check()');
  });
});

// ═══ Multiple collections ═══

describe('multiple collections', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == userId;
    }
    match /posts/{postId} {
      allow create: if request.auth != null
          && request.resource.data.author == request.auth.uid;
      allow read: if true;
    }
  }
}`;

  test('operations on different collections', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES });

    // Create user
    const u = env.execute({
      method: 'create', path: 'users/alice', auth: { uid: 'alice' },
      data: { name: 'Alice' },
    });
    expect(u.allowed).toBe(true);

    // Create post
    const p = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'alice' },
      data: { title: 'Hello', author: 'alice' },
    });
    expect(p.allowed).toBe(true);

    // Wrong user for userId path
    const bad = env.execute({
      method: 'create', path: 'users/bob', auth: { uid: 'alice' },
      data: { name: 'Bob' },
    });
    expect(bad.allowed).toBe(false);

    // List users
    const users = env.listDocuments('users');
    expect(users).toHaveLength(1);
    expect(users[0].data.name).toBe('Alice');

    // List posts
    const posts = env.listDocuments('posts');
    expect(posts).toHaveLength(1);
  });
});

// ═══ Event log inspection ═══

describe('event log', () => {
  test('tracks all operations with metadata', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow create, update, delete: if request.auth != null; }
  }
}`,
    });

    env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'alice' }, data: { x: 1 } });
    env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'alice' }, data: { x: 2 } });
    env.execute({ method: 'delete', path: 'test/d1', auth: { uid: 'alice' } });

    const events = env.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0].method).toBe('create');
    expect(events[0].allowed).toBe(true);
    expect(events[1].method).toBe('update');
    expect(events[2].method).toBe('delete');

    // Each event has a unique ID and timestamp
    expect(events[0].id).not.toBe(events[1].id);
    expect(events[0].timestamp).toBeDefined();
  });

  test('denied operations are logged', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow write: if false; }
  }
}`,
    });

    env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 1 } });
    const events = env.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].allowed).toBe(false);
  });

  test('batch appears as single event', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow create: if request.auth != null; }
  }
}`,
    });

    env.batch([
      { method: 'create', path: 'test/d1', data: { a: 1 } },
      { method: 'create', path: 'test/d2', data: { b: 2 } },
    ], { uid: 'u1' });

    const events = env.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('batch');
    expect(events[0].operations).toHaveLength(2);
  });
});

// ═══ Edge case: empty environment ═══

describe('edge cases', () => {
  test('execute on empty environment uses the open-by-default ruleset', () => {
    const env = new LocalEnvironment();
    // No seed — LocalEnvironment now ships with an open-rules default
    // (rules_version = '2'; allow read, write: if true; on every path)
    // so the quickstart `pyric init` → `bun start` flow doesn't blow up
    // with "Failed to parse rules source" before the caller has even
    // thought about rules. See LocalEnvironment.DEFAULT_OPEN_RULES.
    const r = env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { x: 1 } });
    expect(r.allowed).toBe(true);
  });

  test('update nonexistent document — denied by rules (no resource.data)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow update: if request.auth != null && resource.data.owner == request.auth.uid;
    }
  }
}`,
    });

    const r = env.execute({
      method: 'update', path: 'test/d1', auth: { uid: 'alice' },
      data: { x: 1 },
    });
    // resource.data is null (doc doesn't exist) → resource.data.owner is null → denied
    expect(r.allowed).toBe(false);
  });

  test('snapshot after seed matches seed', () => {
    const env = new LocalEnvironment();
    const docs = { 'a/1': { x: 1 }, 'b/2': { y: 2 } };
    env.seed({ rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{d}/{id} { allow read: if true; } } }`, documents: docs });
    expect(env.snapshot()).toEqual(docs);
  });

  test('redo after new operation clears redo stack', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} { allow create, update: if request.auth != null; }
  }
}`,
    });

    env.execute({ method: 'create', path: 'test/d1', auth: { uid: 'u1' }, data: { v: 1 } });
    env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { v: 2 } });

    env.undo(); // v=2 undone, redo stack has it
    expect(env.getDocument('test/d1')!.v).toBe(1);

    // New operation clears redo stack
    env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data: { v: 99 } });

    // Redo should return null (stack cleared)
    const redone = env.redo();
    expect(redone).toBe(null);
    expect(env.getDocument('test/d1')!.v).toBe(99);
  });
});
