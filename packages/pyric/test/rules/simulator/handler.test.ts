import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();

// ═══ Simple rules for basic tests ═══

const SIMPLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /private/{docId} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
      allow write: if request.auth != null && request.auth.uid == resource.data.owner;
    }
    match /validated/{docId} {
      allow create: if request.auth != null
          && request.resource.data.name != ''
          && request.resource.data.createdBy == request.auth.uid;
      allow update: if request.auth != null
          && request.auth.uid == resource.data.createdBy
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name', 'updatedAt']);
    }
  }
}`;

describe('SimulateFirestoreRulesHandler', () => {

  describe('basic read/write', () => {
    test('public read — always allowed', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'public read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'public/doc1',
      }]);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.passed).toBe(1);
        expect(r.data.results[0].state).toBe('PASSED');
      }
    });

    test('public write unauthenticated — denied', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'unauth write',
        expectation: 'DENY',
        method: 'create',
        path: 'public/doc1',
        auth: null,
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });

    test('public write authenticated — allowed', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'auth write',
        expectation: 'ALLOW',
        method: 'create',
        path: 'public/doc1',
        auth: { uid: 'user1' },
        data: { foo: 'bar' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });
  });

  describe('owner-based access', () => {
    test('owner can read', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'owner read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'private/doc1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });

    test('non-owner denied', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'non-owner read',
        expectation: 'DENY',
        method: 'get',
        path: 'private/doc1',
        auth: { uid: 'bob' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });
  });

  describe('MapDiff validation', () => {
    test('update only allowed fields — allowed', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'update name only',
        expectation: 'ALLOW',
        method: 'update',
        path: 'validated/doc1',
        auth: { uid: 'alice' },
        resource: { createdBy: 'alice', name: 'old', updatedAt: '2024-01-01' },
        data: { createdBy: 'alice', name: 'new', updatedAt: '2024-01-02' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });

    test('update disallowed field — denied', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'update createdBy (disallowed)',
        expectation: 'DENY',
        method: 'update',
        path: 'validated/doc1',
        auth: { uid: 'alice' },
        resource: { createdBy: 'alice', name: 'old' },
        data: { createdBy: 'bob', name: 'old' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });
  });

  describe('multiple test cases', () => {
    test('batch of mixed results', () => {
      const cases: TestCase[] = [
        { description: 'public read', expectation: 'ALLOW', method: 'get', path: 'public/doc1' },
        { description: 'unauth private', expectation: 'DENY', method: 'get', path: 'private/doc1', auth: null, resource: { owner: 'alice' } },
        { description: 'owner private', expectation: 'ALLOW', method: 'get', path: 'private/doc1', auth: { uid: 'alice' }, resource: { owner: 'alice' } },
      ];
      const r = handler.simulate(SIMPLE_RULES, cases);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.passed).toBe(3);
        expect(r.data.failed).toBe(0);
      }
    });
  });

  describe('no match block', () => {
    test('unmatched path — deny', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'unknown collection',
        expectation: 'DENY',
        method: 'get',
        path: 'nonexistent/doc1',
        auth: { uid: 'user1' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });
  });

  describe('get() mocking', () => {
    const RULES_WITH_GET = `rules_version = '2';
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
      allow update: if request.auth != null
          && request.resource.data.moveTo in config().moves[resource.data[request.resource.data.moveFrom]][request.resource.data.moveFrom];
    }
  }
}`;

    test('move validation via config doc lookup', () => {
      const r = handler.simulate(RULES_WITH_GET, [{
        description: 'valid knight move via config lookup',
        expectation: 'ALLOW',
        method: 'update',
        path: 'games/game1',
        auth: { uid: 'user1' },
        resource: { b1: 'N' },
        data: { moveFrom: 'b1', moveTo: 'c3' },
        functionMocks: [{
          function: 'get',
          path: 'gameConfig/chess',
          result: { moves: { N: { b1: { c3: true, a3: true } } } },
        }],
      }]);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.passed).toBe(1);
        expect(r.data.results[0].state).toBe('PASSED');
      }
    });

    test('invalid knight move denied via config lookup', () => {
      const r = handler.simulate(RULES_WITH_GET, [{
        description: 'invalid knight move',
        expectation: 'DENY',
        method: 'update',
        path: 'games/game1',
        auth: { uid: 'user1' },
        resource: { b1: 'N' },
        data: { moveFrom: 'b1', moveTo: 'b3' },
        functionMocks: [{
          function: 'get',
          path: 'gameConfig/chess',
          result: { moves: { N: { b1: { c3: true, a3: true } } } },
        }],
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.passed).toBe(1);
    });
  });

  describe('structured trace', () => {
    test('includes which rule matched', () => {
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'public read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'public/doc1',
      }]);
      expect(r.success).toBe(true);
      if (r.success) {
        const result = r.data.results[0];
        expect(result.decision).toBe('ALLOW');
        expect(result.trace.length).toBeGreaterThan(0);
        const allowEntry = result.trace.find(e => e.verdict === 'ALLOW');
        expect(allowEntry).toBeDefined();
        expect(allowEntry?.conditionText).toBeDefined();
        expect(allowEntry?.line).toBeGreaterThan(0);
      }
    });
  });

  describe('expression trace', () => {
    test('records each sub-expression evaluation in order', () => {
      // private read uses `request.auth != null && request.auth.uid == resource.data.owner`
      // — a binary && with two sub-expressions, each itself a binary op.
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'owner read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'private/p1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const allowEntry = r.data.results[0].trace.find(e => e.verdict === 'ALLOW');
      expect(allowEntry?.expressionTrace).toBeDefined();
      const entries = allowEntry!.expressionTrace!;
      // Root entry is the condition itself — a binaryOp '&&'.
      expect(entries[0]?.kind).toBe('binaryOp');
      expect(entries[0]?.parent).toBeNull();
      // Both sides of the && got evaluated (owner check passed → no short-circuit).
      const skipped = entries.find(e => e.skipped === true);
      expect(skipped).toBeUndefined();
      // The root expression's value is `true`.
      expect(entries[0]?.value).toBe(true);
    });

    test('marks the right operand of && as skipped when LHS is falsy', () => {
      // private read where `request.auth != null` is false (anon caller)
      // — the `request.auth.uid == resource.data.owner` operand should
      // be skipped (otherwise it would have thrown trying to read .uid
      // on null and produced an ERROR verdict).
      const r = handler.simulate(SIMPLE_RULES, [{
        description: 'anon read',
        expectation: 'DENY',
        method: 'get',
        path: 'private/p1',
        auth: null,
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const denyEntry = r.data.results[0].trace.find(e => e.verdict === 'DENY');
      expect(denyEntry?.expressionTrace).toBeDefined();
      const entries = denyEntry!.expressionTrace!;
      const skipped = entries.find(e => e.skipped === true);
      expect(skipped).toBeDefined();
      // The skipped expression is the equality check, not the `!= null`.
      expect(skipped?.kind).toBe('binaryOp');
    });

    test('annotates entries that came from `let` bindings', () => {
      const RULES_WITH_LET = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      function isOwner() {
        let owner = resource.data.owner;
        return request.auth != null && request.auth.uid == owner;
      }
      allow read: if isOwner();
    }
  }
}`;
      const r = handler.simulate(RULES_WITH_LET, [{
        description: 'owner read via let',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const allowEntry = r.data.results[0].trace.find(e => e.verdict === 'ALLOW');
      const entries = allowEntry!.expressionTrace!;
      const letEntry = entries.find(e => e.letBinding?.name === 'owner');
      expect(letEntry).toBeDefined();
      expect(letEntry?.value).toBe('alice');
    });

    test('tags inlined entries with the enclosing function name', () => {
      // Top-level fn called with a parameter expression — verifies (a) the
      // functionCall entry is NOT inlinedFrom (outer scope), (b) parameter
      // expressions are NOT tagged (they evaluate in caller scope), and
      // (c) the body's let / return entries ARE tagged.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      function isAuthor(uid) {
        let storedUid = resource.data.author;
        return uid == storedUid;
      }
      allow read: if isAuthor(request.auth.uid);
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'author read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
        auth: { uid: 'alice' },
        resource: { author: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const allow = r.data.results[0].trace.find(e => e.verdict === 'ALLOW');
      const entries = allow!.expressionTrace!;

      const fnCallEntry = entries.find(e => e.kind === 'functionCall' && e.source === 'isAuthor(request.auth.uid)');
      expect(fnCallEntry?.inlinedFrom).toBeUndefined();

      // Parameter expression (`request.auth.uid` at the call site) is a
      // child of the functionCall entry but evaluates in the CALLER's
      // frame — must not carry inlinedFrom.
      const paramExpr = entries.find(e =>
        e.parent === entries.indexOf(fnCallEntry!) &&
        e.kind === 'memberAccess' &&
        e.source === 'request.auth.uid'
      );
      expect(paramExpr?.inlinedFrom).toBeUndefined();

      // Body entries (let binding + return) ARE in the frame.
      const letEntry = entries.find(e => e.letBinding?.name === 'storedUid');
      expect(letEntry?.inlinedFrom?.name).toBe('isAuthor');

      const returnExpr = entries.find(e => e.source === 'uid == storedUid');
      expect(returnExpr?.inlinedFrom?.name).toBe('isAuthor');
    });

    test('nested function calls produce a stacked frame label', () => {
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      function isAuthed() {
        return request.auth != null;
      }
      function isOwner() {
        return isAuthed() && request.auth.uid == resource.data.owner;
      }
      allow read: if isOwner();
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'nested',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const allow = r.data.results[0].trace.find(e => e.verdict === 'ALLOW');
      const entries = allow!.expressionTrace!;

      // The inner `isAuthed()` call should be tagged inlinedFrom: isOwner
      // (it's IN the body of isOwner). Its body (`request.auth != null`)
      // should be tagged inlinedFrom: isAuthed.
      const innerCall = entries.find(e => e.kind === 'functionCall' && e.source === 'isAuthed()');
      expect(innerCall?.inlinedFrom?.name).toBe('isOwner');

      const innerBody = entries.find(e => e.source === 'request.auth != null');
      expect(innerBody?.inlinedFrom?.name).toBe('isAuthed');
    });
  });

  describe('path resolution trace', () => {
    // Every TestResult now carries a `pathResolution` field that
    // records which match blocks the resolver considered and where
    // each one fell apart. Drives `debug_firestore_rules`'s
    // PATH_MISMATCH near-miss surface.

    const NESTED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if true;
      match /messages/{mId} {
        allow read: if true;
      }
    }
  }
}`;

    test('matched path records the winning block', () => {
      const r = handler.simulate(NESTED_RULES, [{
        description: 'read user',
        expectation: 'ALLOW',
        method: 'get',
        path: 'users/alice',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const pr = r.data.results[0].pathResolution!;
      expect(pr.requestPath).toBe('users/alice');
      const winner = pr.attempts.find(a => a.matched);
      expect(winner).toBeDefined();
      expect(winner!.blockPath).toBe('/users/{uid}');
      expect(winner!.bindings).toEqual({ uid: 'alice' });
      expect(winner!.line).toBeGreaterThan(0);
    });

    test('nested match success records BOTH parent and child as matched', () => {
      // The parent `/users/{uid}` matched its own 2 segments; the
      // child `/messages/{mId}` matched the remaining 2. Both go in
      // the trace as `matched: true` so the agent can render the
      // full resolution chain.
      const r = handler.simulate(NESTED_RULES, [{
        description: 'read nested message',
        expectation: 'ALLOW',
        method: 'get',
        path: 'users/alice/messages/m1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const matched = r.data.results[0].pathResolution!.attempts.filter(a => a.matched);
      expect(matched.length).toBe(2);
      const blockPaths = matched.map(m => m.blockPath).sort();
      expect(blockPaths).toEqual(['/messages/{mId}', '/users/{uid}']);
    });

    test('literal mismatch records the failing block with reason', () => {
      // `users/{uid}` matched on `users`, then... wait, request path
      // `posts/p1` doesn't even start with `users`. So segment 0 is
      // a literal mismatch.
      const r = handler.simulate(NESTED_RULES, [{
        description: 'no match',
        expectation: 'DENY',
        method: 'get',
        path: 'posts/p1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const pr = r.data.results[0].pathResolution!;
      const failed = pr.attempts.filter(a => !a.matched);
      expect(failed.length).toBeGreaterThan(0);
      const usersAttempt = failed.find(a => a.blockPath === '/users/{uid}');
      expect(usersAttempt?.reason).toBe('literal-mismatch');
      expect(usersAttempt?.matchedSegments).toBe(0);
    });

    test('request shorter than block records "request-shorter" reason', () => {
      // Request `users` (1 segment); block `/users/{uid}` (2 segments).
      // The block consumes the literal `users` then runs out of
      // request input on `{uid}`.
      const r = handler.simulate(NESTED_RULES, [{
        description: 'incomplete path',
        expectation: 'DENY',
        method: 'get',
        path: 'users',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const pr = r.data.results[0].pathResolution!;
      const failed = pr.attempts.find(a => a.blockPath === '/users/{uid}' && !a.matched);
      expect(failed?.reason).toBe('request-shorter');
      expect(failed?.matchedSegments).toBe(1);
    });

    test('parent matched but no child matches remaining segments', () => {
      // Request `users/alice/extra/x` — parent `users/{uid}` consumes 2,
      // remaining `extra/x` doesn't match `messages/{mId}`.
      const r = handler.simulate(NESTED_RULES, [{
        description: 'parent ok, no child fit',
        expectation: 'DENY',
        method: 'get',
        path: 'users/alice/extra/x',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const pr = r.data.results[0].pathResolution!;
      const parent = pr.attempts.find(a => a.blockPath === '/users/{uid}' && !a.matched);
      expect(parent?.reason).toBe('no-matching-child');
      expect(parent?.matchedSegments).toBe(2);
    });

    test('blockPath round-trips literal/wildcard/recursive segments', () => {
      // Recursive `{document=**}` rendering matters because the
      // agent's UX quotes blockPath verbatim. Bug-bait: forgetting
      // the `=**` suffix on recursive segments.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{document=**} {
      allow read: if true;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'recursive match',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/a/b/c',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const matched = r.data.results[0].pathResolution!.attempts.find(a => a.matched);
      expect(matched?.blockPath).toBe('/docs/{document=**}');
    });

    test('degenerate rules with NO match blocks produce empty attempts', () => {
      // Valid but useless rules — agent might paste these mid-edit.
      // The resolver has nothing to try, so `attempts` is empty AND
      // the existing "No match block found" note still fires.
      const EMPTY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
  }
}`;
      const r = handler.simulate(EMPTY, [{
        description: 'no rules',
        expectation: 'DENY',
        method: 'get',
        path: 'anything/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const pr = r.data.results[0].pathResolution!;
      expect(pr.attempts).toEqual([]);
      expect(r.data.results[0].notes[0]).toMatch(/No match block found/);
    });

    test('multiple sibling top-level match blocks are each recorded', () => {
      // The resolver tries each child of the root in source order
      // until one matches (or all fail). Each attempt — matched or
      // not — needs an entry. Failure case: request that matches
      // neither block.
      const TWO_SIBLINGS = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /alpha/{x} {
      allow read: if true;
    }
    match /beta/{y} {
      allow read: if true;
    }
  }
}`;
      const r = handler.simulate(TWO_SIBLINGS, [{
        description: 'matches neither',
        expectation: 'DENY',
        method: 'get',
        path: 'gamma/g1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const attempts = r.data.results[0].pathResolution!.attempts;
      // Both sibling blocks should appear in the trace.
      const blockPaths = attempts.map(a => a.blockPath).sort();
      expect(blockPaths).toEqual(['/alpha/{x}', '/beta/{y}']);
      // Both reasoned out as literal-mismatch (first segment 'alpha'/'beta'
      // didn't match request's 'gamma').
      expect(attempts.every(a => !a.matched && a.reason === 'literal-mismatch')).toBe(true);
    });

    test('multiple siblings: ALL are considered (no first-match short-circuit in resolution)', () => {
      // Overlapping-match semantics: the resolver evaluates EVERY sibling
      // block, not just the first that matches, because allows OR-combine
      // across all matching blocks. Here `/alpha/{x}` matches and
      // `/beta/{y}` is a literal-mismatch — but both appear in the trace
      // so the agent's near-miss list is complete.
      const TWO_SIBLINGS = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /alpha/{x} {
      allow read: if true;
    }
    match /beta/{y} {
      allow read: if true;
    }
  }
}`;
      const r = handler.simulate(TWO_SIBLINGS, [{
        description: 'matches first sibling',
        expectation: 'ALLOW',
        method: 'get',
        path: 'alpha/a1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const attempts = r.data.results[0].pathResolution!.attempts;
      const alpha = attempts.find(a => a.blockPath === '/alpha/{x}');
      const beta = attempts.find(a => a.blockPath === '/beta/{y}');
      expect(alpha?.matched).toBe(true);
      // `/beta/{y}` IS recorded now — it was considered, and reasoned out.
      expect(beta?.matched).toBe(false);
      expect(beta?.reason).toBe('literal-mismatch');
    });

    test('request-shorter fires at a literal segment too (not just wildcards)', () => {
      // Earlier coverage hit request-shorter at a wildcard
      // (`users` vs `/users/{uid}`). Completes the matrix: a block
      // whose 2nd segment is a LITERAL the request doesn't supply.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/special {
      allow read: if true;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'short of the literal',
        expectation: 'DENY',
        method: 'get',
        path: 'docs',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const attempt = r.data.results[0].pathResolution!.attempts.find(a => !a.matched);
      // Block path is `/docs/special` — 2 literal segments. Request
      // is `docs` — 1 segment. Block consumed `docs`, then tried to
      // consume `special` but ran out of input.
      expect(attempt?.reason).toBe('request-shorter');
      expect(attempt?.matchedSegments).toBe(1);
      expect(attempt?.totalSegments).toBe(2);
    });
  });

  describe('verdict edge cases', () => {
    // UNSUPPORTED + ERROR verdicts route through different branches in
    // `evaluateRules` than the happy ALLOW / DENY path. These tests pin
    // the contract that each branch attaches `message` and the right
    // verdict — sandbox UI and the playground tool's summary depend on it.

    test('UNSUPPORTED verdict — rule calls an unknown namespace or method', () => {
      // `unknownNamespace.helper()` invokes an unknown namespace not handled
      // by built-ins, throwing UnsupportedError; the handler maps that to
      // verdict='UNSUPPORTED' and decision='UNSUPPORTED'.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if unknownNamespace.helper();
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'unknown namespace',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('UNSUPPORTED');
      // state is UNSUPPORTED (sim abstained), not FAILED.
      expect(result.state).toBe('UNSUPPORTED');
      const entry = result.trace[0];
      expect(entry.verdict).toBe('UNSUPPORTED');
      expect(entry.message).toMatch(/Unknown namespace/);
    });

    test('ERROR verdict — rule calls an undefined function', () => {
      // `unknownHelper()` throws EvalError as an unresolvable function name,
      // evaluating to DENY as standard production rules behavior.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if unknownHelper();
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'unknown helper',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('DENY');
      expect(result.state).toBe('FAILED');
      const entry = result.trace[0];
      expect(entry.verdict).toBe('ERROR');
      expect(entry.message).toMatch(/Unknown function: unknownHelper/);
    });

    test('ERROR verdict — runtime error in the expression (negative slice)', () => {
      // `obj[0:-1]` throws EvalError per evaluator.ts:192 (negative slice
      // indices rejected). EvalError ≠ UnsupportedError, so it maps to
      // verdict='ERROR' and the overall decision is DENY (matching
      // production: runtime errors deny the request).
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if 'abcdef'[0:-1] == 'abcde';
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'negative slice',
        expectation: 'DENY',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('DENY');
      const entry = result.trace[0];
      expect(entry.verdict).toBe('ERROR');
      expect(entry.message).toMatch(/non-negative/);
    });

    test('UNSUPPORTED entries still carry conditionText + line', () => {
      // Even on UNSUPPORTED, the entry shape stays uniform — line + text
      // are populated so the agent can locate the failing rule.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if unknownHelper();
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'unknown fn',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const entry = r.data.results[0].trace[0];
      expect(entry.conditionText).toBeDefined();
      expect(entry.line).toBeGreaterThan(0);
    });
  });

  describe('parse errors', () => {
    test('invalid rules source', () => {
      const r = handler.simulate('not valid rules', [{ description: 'x', expectation: 'DENY', method: 'get', path: 'x/y' }]);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.code).toBe('PARSE_FAILED');
    });
  });

  describe('serverTimestamp sentinel', () => {
    const TS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.resource.data.createdAt == request.time;
    }
  }
}`;

    test('sentinel in data matches request.time', () => {
      const r = handler.simulate(TS_RULES, [{
        description: 'server timestamp',
        expectation: 'ALLOW',
        method: 'create',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        data: { createdAt: { __type: 'serverTimestamp' } },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });

    test('sentinel NOT replaced in resource data (existing doc)', () => {
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow update: if resource.data.createdAt == request.time;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'sentinel in resource should NOT match',
        expectation: 'DENY',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        resource: { createdAt: { __type: 'serverTimestamp' } },
        data: { name: 'updated' },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });

    test('multiple serverTimestamp fields resolve to same time', () => {
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.resource.data.createdAt == request.time
          && request.resource.data.updatedAt == request.time;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'two timestamp fields',
        expectation: 'ALLOW',
        method: 'create',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        data: { createdAt: { __type: 'serverTimestamp' }, updatedAt: { __type: 'serverTimestamp' } },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });

    test('nested serverTimestamp in map', () => {
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.resource.data.meta.createdAt == request.time;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'nested timestamp',
        expectation: 'ALLOW',
        method: 'create',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        data: { meta: { createdAt: { __type: 'serverTimestamp' } } },
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });
  });

  describe('requestTime override (Item 0.F)', () => {
    // Date-gated rules need a deterministic request.time so tests don't
    // flake across CI runs. tc.requestTime pins it; absent → wallclock.
    // Item 1.3 (Risk 1 migration): request.time is now a Timestamp
    // wrapper, not an ISO string — direct `==` against a literal ISO
    // string would always deny. Compare against `timestamp.value(epochMs)`
    // which produces an equivalent Timestamp.
    // 2030-01-01T00:00:00.000Z = 1893456000000 ms
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /epoch/{id} {
      allow create: if request.time == timestamp.value(1893456000000);
    }
  }
}`;

    test('explicit requestTime is used as request.time', () => {
      const r = handler.simulate(RULES, [{
        description: 'pinned time matches',
        expectation: 'ALLOW',
        method: 'create',
        path: 'epoch/d1',
        auth: { uid: 'u1' },
        data: { x: 1 },
        requestTime: '2030-01-01T00:00:00.000Z',
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });

    test('omitted requestTime falls back to wallclock (rule denies the pinned check)', () => {
      const r = handler.simulate(RULES, [{
        description: 'wallclock used when requestTime absent',
        expectation: 'DENY',
        method: 'create',
        path: 'epoch/d1',
        auth: { uid: 'u1' },
        data: { x: 1 },
      }]);
      expect(r.success).toBe(true);
      // Wallclock is virtually never the pinned 2030 instant — rule denies,
      // matching the DENY expectation.
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });

    test('serverTimestamp sentinel is replaced with the pinned requestTime, not wallclock', () => {
      // Item 1.3 (Risk 1 migration): sentinel resolves to a Timestamp
      // wrapper, not an ISO string — compare against `timestamp.value()`.
      const SENTINEL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sentinel/{id} {
      allow create: if request.resource.data.t == timestamp.value(1893456000000);
    }
  }
}`;
      const r = handler.simulate(SENTINEL_RULES, [{
        description: 'sentinel uses pinned time',
        expectation: 'ALLOW',
        method: 'create',
        path: 'sentinel/d1',
        auth: { uid: 'u1' },
        data: { t: { __type: 'serverTimestamp' } },
        requestTime: '2030-01-01T00:00:00.000Z',
      }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.results[0].state).toBe('PASSED');
    });
  });
});

// ═══ RULES-B10: update merges request.resource.data with the existing doc ═══
//
// Prod truth: on an update, request.resource.data (and getAfter()) is the
// EXISTING document merged with the write payload — the full future doc — not
// the payload alone. A rule that asserts an UNCHANGED field
// (request.resource.data.owner == resource.data.owner) only passes when the
// merge is applied. The merge is implemented on the `writeMode: { kind:
// 'update' }` path (projectAfterState) — the path agent-facing simulate()
// callers should use; the sparse `data` no-writeMode default stays payload-only
// because the sandbox LocalEnvironment path pre-merges (see step-08 doc).
describe('RULES-B10: update merge via writeMode in public simulate()', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      // Allow only when the owner is preserved across the update.
      allow update: if request.resource.data.owner == resource.data.owner;
    }
  }
}`;

  test('unchanged field is present in request.resource.data after merge (writeMode)', () => {
    const r = handler.simulate(RULES, [{
      description: 'update preserves owner via merge',
      expectation: 'ALLOW',
      method: 'update',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      writeMode: { kind: 'update' },
      // Existing doc has owner; payload only touches a different field.
      resource: { owner: 'u1', title: 'old' },
      data: { title: 'new' },
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      // Without the merge: request.resource.data == { title: 'new' }, so
      // `.owner` errors (RULES-B2) → DENY. With the merge: owner is present.
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('a sparse payload that DROPS the owner errors → DENY (no merge path)', () => {
    // Without writeMode, request.resource.data is the sparse payload; reading
    // the (absent) owner now ERRORS (RULES-B2) instead of silently reading
    // null — the rule correctly denies rather than spuriously passing.
    const r = handler.simulate(RULES, [{
      description: 'sparse update missing owner',
      expectation: 'DENY',
      method: 'update',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      resource: { owner: 'u1', title: 'old' },
      data: { title: 'new' },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED'); // DENY matches
  });

  test('changed owner is rejected under the merge path', () => {
    const r = handler.simulate(RULES, [{
      description: 'update that changes owner is denied',
      expectation: 'DENY',
      method: 'update',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      writeMode: { kind: 'update' },
      resource: { owner: 'u1', title: 'old' },
      data: { owner: 'u2' },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED'); // DENY matches expectation
  });
});

// ═══ RULES-B5: int/float + integer division, end-to-end through the parser ═══
//
// These run the real grammar (which tags float literals via `number_float` →
// a `.` in `raw`), proving the value-model distinction survives the full
// simulate() path, not just hand-built ASTs.
describe('RULES-B5 end-to-end: integer division + is int/float', () => {
  const DIV_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /m/{id} {
      // 10 / 4 is INTEGER division → 2 in prod (NOT 2.5). The rule allows only
      // when that truncation holds, so an ALLOW here proves int division.
      allow read: if 10 / 4 == 2;
      // div-by-zero (int) ERRORS → denies. Guard with the && so the LHS
      // determines; here we want the error to propagate and deny the write.
      allow write: if request.resource.data.n / 0 == 0;
    }
    match /typed/{id} {
      // LITERAL-level int/float distinction: 1.0 is float, 1 is int. These are
      // value-model facts independent of stored data (see the stored-data
      // limitation note + test below).
      allow create: if 1.0 is float && 1 is int && !(1.5 is int) && !(2 is float);
    }
  }
}`;

  test('10 / 4 == 2 ALLOWs (integer division, not 2.5)', () => {
    const r = handler.simulate(DIV_RULES, [{
      description: 'int division read',
      expectation: 'ALLOW',
      method: 'get',
      path: 'm/x',
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('n / 0 DENIES (int division by zero errors)', () => {
    const r = handler.simulate(DIV_RULES, [{
      description: 'div by zero denies',
      expectation: 'DENY',
      method: 'create',
      path: 'm/x',
      auth: { uid: 'u1' },
      data: { n: 5 },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED'); // DENY matches
  });

  test('literal is float/is int distinction ALLOWs (1.0 is float, 1 is int, 1.5 is NOT int)', () => {
    const r = handler.simulate(DIV_RULES, [{
      description: 'literal type distinction',
      expectation: 'ALLOW',
      method: 'create',
      path: 'typed/x',
      auth: { uid: 'u1' },
      data: { price: 1.5, count: 7 },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('firestore#138a revives a tagged float in nested test data', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /s/{id} { allow create: if request.resource.data.nested.price is float; }
  }
}`;
    const r = handler.simulate(rules, [{
      description: 'tagged stored float remains a float',
      expectation: 'ALLOW',
      method: 'create',
      path: 's/x',
      auth: { uid: 'u1' },
      data: { nested: { price: { __type: 'float', value: 1.5 } } },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('firestore#138a treats a raw non-integer test payload as a float', () => {
    const r = handler.simulate(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /prices/{id} {
      allow create: if request.resource.data.price is float
        && !(request.resource.data.price is int);
    }
  }
}`, [{
      description: 'non-integer payload keeps its Firestore double type',
      expectation: 'ALLOW',
      method: 'create',
      path: 'prices/x',
      auth: { uid: 'u1' },
      data: { price: 1.5 },
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  describe('overlapping match blocks — allows OR-combine (firestore.overlapping-match-or)', () => {
    // Production Firestore semantics: when MULTIPLE match blocks match the
    // same document path, the request is allowed if ANY matching block's
    // applicable allow evaluates true. Allows OR-combine across all matching
    // blocks — there is NO first-match-wins, and no block can revoke a grant
    // made by another block. The simulator previously stopped at the first
    // matching block in source order, producing a FALSE DENY whenever an
    // earlier block denied but a later overlapping block would have allowed
    // (a security-relevant divergence: agents would harden a rule that
    // production already permits, or miss that a `{document=**}` catch-all
    // silently opens a path). These cases pin the OR-combine contract.

    test('second block allows what the first denies — production ALLOWS', () => {
      // `/docs/{doc}` (source-first) denies for this request; the sibling
      // catch-all `/{document=**}` allows. OR-combine → ALLOW. Under the old
      // first-match-wins resolver this was a false DENY.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{doc} {
      allow read: if false;
    }
    match /{document=**} {
      allow read: if true;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'first denies, second (catch-all) allows',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('ALLOW');
      expect(result.state).toBe('PASSED');
    });

    test('reverse source order — first block allows, later denies — still ALLOWS', () => {
      // Same two blocks, order flipped: the catch-all comes first and
      // allows. The verdict must not depend on source order — either
      // ordering grants, because a deny cannot revoke an allow.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if true;
    }
    match /docs/{doc} {
      allow read: if false;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'catch-all first allows, specific denies',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('nested {document=**} catch-all overlaps a specific match', () => {
      // A recursive wildcard block matches paths of any depth. Here it
      // overlaps the specific `/rooms/{room}/msgs/{msg}` block. The specific
      // block denies (wrong owner); the catch-all grants admins. Deep path
      // must resolve BOTH blocks and OR-combine to ALLOW.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth.uid == resource.data.owner;
    }
    match /{path=**} {
      allow read: if request.auth.token.admin == true;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'admin reads via catch-all despite specific-block deny',
        expectation: 'ALLOW',
        method: 'get',
        path: 'rooms/r1/msgs/m1',
        auth: { uid: 'someoneElse', token: { admin: true } },
        resource: { owner: 'owner1' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('DENY requires NO matching block to allow — both blocks deny → DENY', () => {
      // Deny-by-default is preserved: when every matching block's applicable
      // allow evaluates false, the request is denied. Both the specific
      // block and the catch-all deny this request.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{doc} {
      allow read: if false;
    }
    match /{document=**} {
      allow read: if request.auth != null;
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'neither block grants — deny',
        expectation: 'DENY',
        method: 'get',
        path: 'docs/d1',
        auth: null,
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('DENY');
      expect(result.state).toBe('PASSED');
      // The DENY trace carries entries from BOTH evaluated blocks, each
      // tagged with the block it came from so the report is unambiguous.
      const blockPaths = result.trace.map(e => e.matchPath).sort();
      expect(blockPaths).toEqual(['/docs/{doc}', '/{document=**}']);
      expect(result.trace.every(e => e.verdict === 'DENY')).toBe(true);
    });

    test('each block binds its OWN wildcard names independently', () => {
      // The two overlapping blocks name the SAME path segment differently
      // (`{doc}` vs `{id}`). Each block's condition reads its own wildcard;
      // resolution must bind per-block, not leak one block's names into the
      // other. The first block denies (compares to a non-matching literal);
      // the second allows because `id` binds to the actual segment.
      const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{doc} {
      allow read: if doc == 'nope';
    }
    match /items/{id} {
      allow read: if id == 'real1';
    }
  }
}`;
      const r = handler.simulate(RULES, [{
        description: 'per-block wildcard binding',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/real1',
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const result = r.data.results[0];
      expect(result.decision).toBe('ALLOW');
      expect(result.state).toBe('PASSED');
      // The granting entry is the `{id}` block; its `id` bound to 'real1'.
      const granting = result.trace.find(e => e.verdict === 'ALLOW');
      expect(granting?.matchPath).toBe('/items/{id}');
    });
  });

  // ═══ resource is null on create (pre-write doc does not exist) ═══
  //
  // Production truth: on a `create`, the target document does not exist yet,
  // so the top-level `resource` is null — any field access (`resource.data`,
  // `resource.id`, `resource.__name__`) errors and the rule DENYs. The
  // simulator previously synthesized a `resource` (empty data + a derived
  // id/__name__) on create, producing a FALSE-ALLOW for the extremely common
  // ownership/existence idioms below. `request.resource` (the INCOMING
  // proposed data) is a DIFFERENT value and must stay populated on create.
  describe('resource is null on create', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Ownership check against the PRE-WRITE doc — the classic false-allow.
    match /owned/{id} {
      allow create: if resource.data.owner == request.auth.uid;
    }
    // resource.id on create.
    match /byId/{id} {
      allow create: if resource.id == id;
    }
    // resource.__name__ on create.
    match /byName/{id} {
      allow create: if resource.__name__ == request.path;
    }
    // request.resource (INCOMING data) MUST still work on create.
    match /incoming/{id} {
      allow create: if request.resource.data.owner == request.auth.uid;
    }
    // Existing-doc reads on update/delete must be UNREGRESSED.
    match /docs/{id} {
      allow update: if resource.data.owner == request.auth.uid;
      allow delete: if resource.data.owner == request.auth.uid;
      allow get: if resource.data.owner == request.auth.uid;
    }
  }
}`;

    test('resource.data ownership on create DENIES (resource is null pre-write)', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.data.owner on create',
        expectation: 'DENY',
        method: 'create',
        path: 'owned/d1',
        auth: { uid: 'alice' },
        data: { owner: 'alice' }, // incoming says alice, but resource is null → DENY
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('DENY');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('resource.id on create DENIES (resource is null pre-write)', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.id on create',
        expectation: 'DENY',
        method: 'create',
        path: 'byId/d2',
        auth: { uid: 'alice' },
        data: {},
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('DENY');
    });

    test('resource.__name__ on create DENIES (resource is null pre-write)', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.__name__ on create',
        expectation: 'DENY',
        method: 'create',
        path: 'byName/d3',
        auth: { uid: 'alice' },
        data: {},
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('DENY');
    });

    test('request.resource (incoming data) is UNAFFECTED on create — ALLOW', () => {
      const r = handler.simulate(RULES, [{
        description: 'request.resource.data.owner on create',
        expectation: 'ALLOW',
        method: 'create',
        path: 'incoming/d4',
        auth: { uid: 'alice' },
        data: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('resource reflects the existing doc on update — UNREGRESSED ALLOW', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.data.owner on update',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d5',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
        data: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('resource reflects the existing doc on delete — UNREGRESSED ALLOW', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.data.owner on delete',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'docs/d6',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });

    test('resource reflects the existing doc on get — UNREGRESSED ALLOW', () => {
      const r = handler.simulate(RULES, [{
        description: 'resource.data.owner on get',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d7',
        auth: { uid: 'alice' },
        resource: { owner: 'alice' },
      }]);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.results[0].decision).toBe('ALLOW');
      expect(r.data.results[0].state).toBe('PASSED');
    });
  });
});

// ─── debug() fails evaluation as function-not-found ──────────────────
//
// Production rejects a ruleset that calls debug() at compile time
// ("Function not found error: Name: [debug]"). The simulator cannot
// reject at compile time, because it evaluates per case, so the parity
// point is evaluation: debug() must fail as an unknown function, the
// exact message the conformance rejection-signature normalizer maps to
// `function-not-found:debug`, and must never pass its argument through.

describe('debug() is not a builtin (production parity)', () => {
  const DEBUG_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if debug(request.auth != null);
    }
  }
}`;

  test('evaluating debug() errors as Unknown function and denies', () => {
    const r = handler.simulate(DEBUG_RULES, [{
      description: 'debug passthrough must not allow',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/a',
      auth: { uid: 'u' },
    }]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.results[0].decision).toBe('DENY');
    const errors = r.data.results[0].trace.filter(t => t.verdict === 'ERROR');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Unknown function: debug');
  });

  test('a user-defined function named debug still resolves', () => {
    // The grammar reserves nothing at parse time; if the author defines
    // their own debug(), the evaluator uses it like any user function.
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function debug(v) { return v; }
    match /docs/{id} {
      allow read: if debug(request.auth != null);
    }
  }
}`;
    const r = handler.simulate(rules, [{
      description: 'user debug fn',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/a',
      auth: { uid: 'u' },
    }]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.results[0].decision).toBe('ALLOW');
  });
});
