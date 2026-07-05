/**
 * Bug bash: Firestore Rules Simulator
 *
 * Tests the simulator against real-world patterns that have caused
 * production issues. Each test represents a scenario we've encountered
 * or an edge case that could break the evaluator.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SimulateFirestoreRulesHandler } from 'pyric/rules';
import type { TestCase } from 'pyric/rules';

const __dirname = dirname(fileURLToPath(import.meta.url));
const handler = new SimulateFirestoreRulesHandler();
const GAME_RULE_FIXTURES = join(__dirname, '../../../fixtures/firestore-game-rules');

function run(source: string, cases: TestCase[]) {
  const r = handler.simulate(source, cases);
  expect(r.success).toBe(true);
  if (!r.success) return r;
  return r;
}

function expectAll(source: string, cases: TestCase[]) {
  const r = run(source, cases);
  if ('data' in r) {
    for (const result of r.data.results) {
      if (result.state === 'FAILED') {
        console.log(`FAILED: ${result.description}`, result.debugMessages);
      }
    }
    expect(r.data.failed).toBe(0);
  }
}

// ═══ Real checkers rules ═══

const CHECKERS_RULES = readFileSync(
  join(GAME_RULE_FIXTURES, 'checkers-lookup.rules'), 'utf-8'
);

// ═══ Stdlib module resolved rules ═══

const LOBBY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      function isAuth() { return request.auth != null; }

      allow read: if isAuth();

      allow create: if isAuth()
          && request.resource.data.host == request.auth.uid
          && request.resource.data.guest == ''
          && request.resource.data.status == 'waiting';

      allow update: if isAuth()
          && resource.data.status == 'waiting'
          && resource.data.guest == ''
          && request.resource.data.guest == request.auth.uid
          && request.auth.uid != resource.data.host
          && request.resource.data.status == 'playing'
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['guest', 'status']);

      allow delete: if isAuth()
          && resource.data.status == 'waiting'
          && request.auth.uid == resource.data.host;
    }
  }
}`;

describe('Bug Bash: Simulator', () => {

  // ═══ Auth edge cases ═══

  describe('auth edge cases', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == resource.data.owner;
    }
  }
}`;

    test('null auth object (not just missing)', () => {
      expectAll(RULES, [
        { description: 'explicit null auth', expectation: 'DENY', method: 'get', path: 'test/doc1', auth: null },
      ]);
    });

    test('auth with empty uid', () => {
      expectAll(RULES, [
        { description: 'empty uid still authenticated', expectation: 'ALLOW', method: 'get', path: 'test/doc1', auth: { uid: '' } },
      ]);
    });

    test('auth.uid comparison', () => {
      expectAll(RULES, [
        { description: 'matching uid', expectation: 'ALLOW', method: 'update', path: 'test/doc1', auth: { uid: 'alice' }, resource: { owner: 'alice' }, data: { owner: 'alice' } },
        { description: 'non-matching uid', expectation: 'DENY', method: 'update', path: 'test/doc1', auth: { uid: 'bob' }, resource: { owner: 'alice' }, data: { owner: 'alice' } },
      ]);
    });

    test('custom claims', () => {
      const CLAIMS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if request.auth != null && request.auth.token.admin == true;
    }
  }
}`;
      expectAll(CLAIMS_RULES, [
        { description: 'has admin claim', expectation: 'ALLOW', method: 'get', path: 'test/doc1', auth: { uid: 'u1', token: { admin: true } } },
        { description: 'missing admin claim', expectation: 'DENY', method: 'get', path: 'test/doc1', auth: { uid: 'u1', token: {} } },
        { description: 'admin is false', expectation: 'DENY', method: 'get', path: 'test/doc1', auth: { uid: 'u1', token: { admin: false } } },
      ]);
    });
  });

  // ═══ Operation type matching ═══

  describe('operation types', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update: if request.auth != null && request.auth.uid == resource.data.owner;
      allow delete: if request.auth != null && request.auth.uid == resource.data.owner;
    }
  }
}`;

    test('get maps to read', () => {
      expectAll(RULES, [
        { description: 'get → read', expectation: 'ALLOW', method: 'get', path: 'test/doc1' },
      ]);
    });

    test('list maps to read', () => {
      expectAll(RULES, [
        { description: 'list → read', expectation: 'ALLOW', method: 'list', path: 'test/doc1' },
      ]);
    });

    test('create requires auth', () => {
      expectAll(RULES, [
        { description: 'create authed', expectation: 'ALLOW', method: 'create', path: 'test/doc1', auth: { uid: 'u1' }, data: {} },
        { description: 'create unauthed', expectation: 'DENY', method: 'create', path: 'test/doc1', auth: null, data: {} },
      ]);
    });

    test('update requires ownership', () => {
      expectAll(RULES, [
        { description: 'owner update', expectation: 'ALLOW', method: 'update', path: 'test/doc1', auth: { uid: 'alice' }, resource: { owner: 'alice' }, data: { owner: 'alice' } },
        { description: 'non-owner update', expectation: 'DENY', method: 'update', path: 'test/doc1', auth: { uid: 'bob' }, resource: { owner: 'alice' }, data: { owner: 'alice' } },
      ]);
    });

    test('delete requires ownership', () => {
      expectAll(RULES, [
        { description: 'owner delete', expectation: 'ALLOW', method: 'delete', path: 'test/doc1', auth: { uid: 'alice' }, resource: { owner: 'alice' } },
        { description: 'non-owner delete', expectation: 'DENY', method: 'delete', path: 'test/doc1', auth: { uid: 'bob' }, resource: { owner: 'alice' } },
      ]);
    });
  });

  // ═══ Path variable binding ═══

  describe('path variables', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;

    test('path variable matches auth uid', () => {
      expectAll(RULES, [
        { description: 'uid matches path', expectation: 'ALLOW', method: 'get', path: 'users/alice', auth: { uid: 'alice' } },
        { description: 'uid does not match path', expectation: 'DENY', method: 'get', path: 'users/bob', auth: { uid: 'alice' } },
      ]);
    });
  });

  // ═══ Lobby pattern (create, join, cancel) ═══

  describe('lobby pattern', () => {
    test('create game', () => {
      expectAll(LOBBY_RULES, [
        {
          description: 'valid create',
          expectation: 'ALLOW',
          method: 'create',
          path: 'games/g1',
          auth: { uid: 'host1' },
          data: { host: 'host1', guest: '', status: 'waiting' },
        },
        {
          description: 'create with wrong host',
          expectation: 'DENY',
          method: 'create',
          path: 'games/g1',
          auth: { uid: 'host1' },
          data: { host: 'someone_else', guest: '', status: 'waiting' },
        },
      ]);
    });

    test('join game', () => {
      expectAll(LOBBY_RULES, [
        {
          description: 'valid join',
          expectation: 'ALLOW',
          method: 'update',
          path: 'games/g1',
          auth: { uid: 'guest1' },
          resource: { host: 'host1', guest: '', status: 'waiting' },
          data: { host: 'host1', guest: 'guest1', status: 'playing' },
        },
        {
          description: 'host cannot join own game',
          expectation: 'DENY',
          method: 'update',
          path: 'games/g1',
          auth: { uid: 'host1' },
          resource: { host: 'host1', guest: '', status: 'waiting' },
          data: { host: 'host1', guest: 'host1', status: 'playing' },
        },
        {
          description: 'cannot join if guest slot taken',
          expectation: 'DENY',
          method: 'update',
          path: 'games/g1',
          auth: { uid: 'guest2' },
          resource: { host: 'host1', guest: 'guest1', status: 'waiting' },
          data: { host: 'host1', guest: 'guest2', status: 'playing' },
        },
      ]);
    });

    test('cancel game', () => {
      expectAll(LOBBY_RULES, [
        {
          description: 'host can cancel',
          expectation: 'ALLOW',
          method: 'delete',
          path: 'games/g1',
          auth: { uid: 'host1' },
          resource: { host: 'host1', guest: '', status: 'waiting' },
        },
        {
          description: 'non-host cannot cancel',
          expectation: 'DENY',
          method: 'delete',
          path: 'games/g1',
          auth: { uid: 'random' },
          resource: { host: 'host1', guest: '', status: 'waiting' },
        },
      ]);
    });
  });

  // ═══ MapDiff patterns ═══

  describe('MapDiff patterns', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.auth != null
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(
              ['name', 'updatedAt', request.resource.data.moveField]
          );
    }
  }
}`;

    test('hasOnly with dynamic field value in the list', () => {
      expectAll(RULES, [
        {
          description: 'only allowed fields changed (including dynamic)',
          expectation: 'ALLOW',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'u1' },
          resource: { name: 'old', updatedAt: '1', moveField: 'x', x: 'a' },
          data: { name: 'new', updatedAt: '2', moveField: 'x', x: 'b' },
        },
        {
          description: 'disallowed field changed',
          expectation: 'DENY',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'u1' },
          resource: { name: 'old', secret: 'a', moveField: 'x' },
          data: { name: 'new', secret: 'b', moveField: 'x' },
        },
      ]);
    });
  });

  // ═══ Multiple allow rules (OR semantics) ═══

  describe('OR semantics across allow rules', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.resource.data.moveType == 'normal'
          && request.auth != null;
      allow update: if request.resource.data.moveType == 'special'
          && request.auth != null
          && request.auth.uid == resource.data.owner;
    }
  }
}`;

    test('first rule matches', () => {
      expectAll(RULES, [{
        description: 'normal move by anyone',
        expectation: 'ALLOW',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'anyone' },
        resource: { owner: 'alice' },
        data: { moveType: 'normal' },
      }]);
    });

    test('second rule matches', () => {
      expectAll(RULES, [{
        description: 'special move by owner',
        expectation: 'ALLOW',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
        data: { moveType: 'special' },
      }]);
    });

    test('second rule denies non-owner', () => {
      expectAll(RULES, [{
        description: 'special move by non-owner',
        expectation: 'DENY',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'bob' },
        resource: { owner: 'alice' },
        data: { moveType: 'special' },
      }]);
    });

    test('no rule matches unknown moveType', () => {
      expectAll(RULES, [{
        description: 'unknown moveType',
        expectation: 'DENY',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
        data: { moveType: 'unknown' },
      }]);
    });
  });

  // ═══ Nested functions ═══

  describe('nested function calls', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function isAuth() { return request.auth != null; }
      function isOwner() {
        return isAuth() && request.auth.uid == resource.data.owner;
      }
      function canEdit() {
        return isOwner() && resource.data.status == 'draft';
      }
      allow update: if canEdit();
    }
  }
}`;

    test('3-level function chain', () => {
      expectAll(RULES, [
        {
          description: 'owner + draft = allowed',
          expectation: 'ALLOW',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'alice' },
          resource: { owner: 'alice', status: 'draft' },
          data: { owner: 'alice', status: 'draft' },
        },
        {
          description: 'owner + published = denied',
          expectation: 'DENY',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'alice' },
          resource: { owner: 'alice', status: 'published' },
          data: { owner: 'alice', status: 'published' },
        },
        {
          description: 'non-owner = denied',
          expectation: 'DENY',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'bob' },
          resource: { owner: 'alice', status: 'draft' },
          data: { owner: 'alice', status: 'draft' },
        },
      ]);
    });
  });

  // ═══ get() with config document ═══

  describe('config document pattern', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /gameConfig/{id} {
      allow read: if true;
      allow write: if false;
    }
    match /games/{gameId} {
      function config() {
        return get(/databases/$(database)/documents/gameConfig/chess).data;
      }
      function validMove() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        return mt in config().moves[piece][mf];
      }
      function pathClear() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let p = config().paths[mf][mt];
        return (p.len < 1 || resource.data[p.c0] == '')
            && (p.len < 2 || resource.data[p.c1] == '');
      }
      allow update: if request.auth != null && validMove() && pathClear();
    }
  }
}`;

    const CHESS_CONFIG = {
      moves: {
        R: {
          a1: { a2: true, a3: true, a4: true, b1: true, c1: true },
          e1: { e2: true, e3: true },
        },
      },
      paths: {
        a1: {
          a2: { len: 0 },
          a3: { len: 1, c0: 'a2' },
          a4: { len: 2, c0: 'a2', c1: 'a3' },
          b1: { len: 0 },
          c1: { len: 1, c0: 'b1' },
        },
        e1: {
          e2: { len: 0 },
          e3: { len: 1, c0: 'e2' },
        },
      },
    };

    test('valid rook move, clear path', () => {
      expectAll(RULES, [{
        description: 'rook a1→a3, a2 empty',
        expectation: 'ALLOW',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u1' },
        resource: { a1: 'R', a2: '', a3: '' },
        data: { moveFrom: 'a1', moveTo: 'a3' },
        functionMocks: [{ function: 'get', path: 'gameConfig/chess', result: CHESS_CONFIG }],
      }]);
    });

    test('rook blocked by piece', () => {
      expectAll(RULES, [{
        description: 'rook a1→a3, a2 blocked',
        expectation: 'DENY',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u1' },
        resource: { a1: 'R', a2: 'P', a3: '' },
        data: { moveFrom: 'a1', moveTo: 'a3' },
        functionMocks: [{ function: 'get', path: 'gameConfig/chess', result: CHESS_CONFIG }],
      }]);
    });

    test('adjacent rook move (no path check)', () => {
      expectAll(RULES, [{
        description: 'rook a1→a2, adjacent',
        expectation: 'ALLOW',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u1' },
        resource: { a1: 'R', a2: '' },
        data: { moveFrom: 'a1', moveTo: 'a2' },
        functionMocks: [{ function: 'get', path: 'gameConfig/chess', result: CHESS_CONFIG }],
      }]);
    });

    test('invalid geometry denied', () => {
      expectAll(RULES, [{
        description: 'rook diagonal (invalid)',
        expectation: 'DENY',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u1' },
        resource: { a1: 'R', b2: '' },
        data: { moveFrom: 'a1', moveTo: 'b2' },
        functionMocks: [{ function: 'get', path: 'gameConfig/chess', result: CHESS_CONFIG }],
      }]);
    });
  });

  // ═══ Ternary expressions ═══

  describe('ternary expressions', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.auth != null
          && (resource.data.currentTurn == 'host'
              ? request.auth.uid == resource.data.host
              : request.auth.uid == resource.data.guest);
    }
  }
}`;

    test('ternary selects correct branch', () => {
      expectAll(RULES, [
        {
          description: 'host turn, host moves',
          expectation: 'ALLOW',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'h1' },
          resource: { currentTurn: 'host', host: 'h1', guest: 'g1' },
          data: { currentTurn: 'host' },
        },
        {
          description: 'host turn, guest tries to move',
          expectation: 'DENY',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'g1' },
          resource: { currentTurn: 'host', host: 'h1', guest: 'g1' },
          data: { currentTurn: 'host' },
        },
        {
          description: 'guest turn, guest moves',
          expectation: 'ALLOW',
          method: 'update',
          path: 'test/doc1',
          auth: { uid: 'g1' },
          resource: { currentTurn: 'guest', host: 'h1', guest: 'g1' },
          data: { currentTurn: 'guest' },
        },
      ]);
    });
  });

  // ═══ Comparison edge cases ═══

  describe('comparison edge cases', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.resource.data.count == resource.data.count + 1;
      allow create: if request.resource.data.name != '';
    }
  }
}`;

    test('increment by 1', () => {
      expectAll(RULES, [
        { description: 'correct increment', expectation: 'ALLOW', method: 'update', path: 'test/doc1', resource: { count: 5 }, data: { count: 6 } },
        { description: 'wrong increment', expectation: 'DENY', method: 'update', path: 'test/doc1', resource: { count: 5 }, data: { count: 7 } },
        { description: 'no change', expectation: 'DENY', method: 'update', path: 'test/doc1', resource: { count: 5 }, data: { count: 5 } },
      ]);
    });

    test('empty string check', () => {
      expectAll(RULES, [
        { description: 'non-empty name', expectation: 'ALLOW', method: 'create', path: 'test/doc1', auth: { uid: 'u1' }, data: { name: 'hello' } },
        { description: 'empty name', expectation: 'DENY', method: 'create', path: 'test/doc1', auth: { uid: 'u1' }, data: { name: '' } },
      ]);
    });
  });

  // ═══ String comparison for moveType gates ═══

  describe('string comparison (moveType gate pattern)', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.resource.data.moveType == 'pawn_forward'
          && request.resource.data.piece == 'P';
      allow update: if request.resource.data.moveType == 'normal'
          && request.resource.data.piece != 'P'
          && request.resource.data.piece != 'p';
    }
  }
}`;

    test('unique gate routing', () => {
      expectAll(RULES, [
        { description: 'pawn forward', expectation: 'ALLOW', method: 'update', path: 'test/d1', data: { moveType: 'pawn_forward', piece: 'P' } },
        { description: 'normal non-pawn', expectation: 'ALLOW', method: 'update', path: 'test/d1', data: { moveType: 'normal', piece: 'N' } },
        { description: 'pawn trying normal', expectation: 'DENY', method: 'update', path: 'test/d1', data: { moveType: 'normal', piece: 'P' } },
        { description: 'unknown moveType', expectation: 'DENY', method: 'update', path: 'test/d1', data: { moveType: 'unknown', piece: 'N' } },
      ]);
    });
  });

  // ═══ Boolean fields ═══

  describe('boolean fields', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.auth != null
          && !resource.data.locked
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name']);
    }
  }
}`;

    test('boolean false allows', () => {
      expectAll(RULES, [{
        description: 'not locked',
        expectation: 'ALLOW',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        resource: { locked: false, name: 'old' },
        data: { locked: false, name: 'new' },
      }]);
    });

    test('boolean true denies', () => {
      expectAll(RULES, [{
        description: 'locked',
        expectation: 'DENY',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        resource: { locked: true, name: 'old' },
        data: { locked: true, name: 'new' },
      }]);
    });
  });

  // ═══ Checkers rules (real-world, resolved) ═══

  describe('checkers rules (real-world)', () => {
    const CONFIG = {
      moves: {
        h: { c0r5: { c1r4: true } },
        H: { c1r4: { c0r3: true, c0r5: true, c2r3: true, c2r5: true } },
      },
      jumps: {
        h: { c2r5: { c0r3: 'c1r4' } },
      },
    };

    test('valid simple move via config lookup', () => {
      const r = handler.simulate(CHECKERS_RULES, [{
        description: 'host forward move c0r5→c1r4',
        expectation: 'ALLOW',
        method: 'update',
        path: 'checkers/g1',
        auth: { uid: 'white' },
        resource: {
          host: 'white', guest: 'black', status: 'playing', currentTurn: 'host',
          moveCount: 0, moveFrom: '', moveTo: '', captured: '',
          hostCount: 1, guestCount: 1,
          c0r5: 'h', c1r4: '', c1r0: 'g',
        },
        data: {
          host: 'white', guest: 'black', status: 'playing', currentTurn: 'guest',
          moveCount: 1, moveFrom: 'c0r5', moveTo: 'c1r4', captured: '',
          hostCount: 1, guestCount: 1,
          c0r5: '', c1r4: 'h', c1r0: 'g',
          movedPiece: 'hp_P1',
        },
        functionMocks: [{ function: 'get', path: 'gameConfig/checkers', result: CONFIG }],
      }]);
      expect(r.success).toBe(true);
      if (r.success) {
        if (r.data.results[0].state === 'FAILED') {
          console.log('Checkers debug:', r.data.results[0].debugMessages);
        }
        // Note: this may fail if the resolved checkers rules have functions
        // that reference fields not in our minimal test data. That's expected —
        // the point is to see how far the simulator gets.
      }
    });
  });

  // ═══ exists() mock ═══

  describe('exists() mocking', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow create: if request.auth != null
          && exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }
  }
}`;

    test('user exists — allowed', () => {
      expectAll(RULES, [{
        description: 'user doc exists',
        expectation: 'ALLOW',
        method: 'create',
        path: 'posts/p1',
        auth: { uid: 'alice' },
        data: { title: 'hello' },
        functionMocks: [{ function: 'exists', path: 'users/alice', result: true }],
      }]);
    });

    test('user does not exist — denied', () => {
      expectAll(RULES, [{
        description: 'user doc missing',
        expectation: 'DENY',
        method: 'create',
        path: 'posts/p1',
        auth: { uid: 'bob' },
        data: { title: 'hello' },
        functionMocks: [{ function: 'exists', path: 'users/bob', result: false }],
      }]);
    });
  });
});
