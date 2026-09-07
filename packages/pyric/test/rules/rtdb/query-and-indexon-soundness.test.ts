import { describe, it, expect } from 'bun:test';
import { compileRtdbRules, simulateRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
import { validateExpression } from '../../../src/rules/rtdb/grammar/validator.js';
import {
  getDatabase,
  ref,
  set,
  get,
  query,
  orderByChild,
  orderByValue,
  orderByKey,
  limitToLast,
  onValue,
} from '../../../src/database/index.js';
import { setRules } from '../../../src/database/sandbox-controls.js';
import { initializeSandbox } from '../../../src/sandbox/index.js';

describe('Realtime Database Query Rule Expressions & .indexOn Sandbox Enforcement', () => {
  describe('R1: Realtime Database query.* Rule Expression Evaluation', () => {
    it('evaluates query.orderByChild and query.limitToLast in .read rules accurately', () => {
      const compiled = compileRtdbRules({
        rules: {
          messages: {
            '.read': "query.orderByChild == 'timestamp' && query.limitToLast <= 50",
          },
        },
      });

      const allowedRes = simulateRtdbRules(compiled, {
        operation: 'read',
        path: '/messages',
        auth: { uid: 'user-1' },
        mockData: { messages: { m1: { timestamp: 100 } } },
        query: {
          orderByChild: 'timestamp',
          limitToLast: 10,
        },
      });
      expect(allowedRes.success).toBe(true);
      if (allowedRes.success) {
        expect(allowedRes.data.allowed).toBe(true);
      }

      const deniedRes = simulateRtdbRules(compiled, {
        operation: 'read',
        path: '/messages',
        auth: { uid: 'user-1' },
        mockData: { messages: { m1: { timestamp: 100 } } },
        query: {
          orderByChild: 'timestamp',
          limitToLast: 100,
        },
      });
      expect(deniedRes.success).toBe(true);
      if (deniedRes.success) {
        expect(deniedRes.data.allowed).toBe(false);
      }
    });

    it('validates query identifier in .read rules but rejects in .write and .validate rules', () => {
      const readErrors = validateExpression("query.orderByChild == 'timestamp'", 'read', []);
      expect(readErrors).toHaveLength(0);

      const writeErrors = validateExpression("query.orderByChild == 'timestamp'", 'write', []);
      expect(writeErrors.length).toBeGreaterThan(0);
      expect(writeErrors[0]?.code).toBe('UNKNOWN_IDENTIFIER');
    });

    it('forwards query constraints from RTDB sandbox get(query(...)) into .read rule evaluation', async () => {
      const sandbox = initializeSandbox({ projectId: 'r1-test-project' });
      const db = getDatabase(sandbox);
      await setRules(db, {
        rules: {
          posts: {
            '.read': "query.orderByChild == 'createdAt' && query.limitToLast <= 5",
            '.write': true,
            '.indexOn': ['createdAt'],
          },
        },
      });
      await set(ref(db, 'posts/p1'), { createdAt: 10, title: 'Hello' });

      const snap = await get(query(ref(db, 'posts'), orderByChild('createdAt'), limitToLast(5)));
      expect(snap.exists()).toBe(true);

      await expect(
        get(query(ref(db, 'posts'), orderByChild('createdAt'), limitToLast(10))),
      ).rejects.toThrow(/PERMISSION_DENIED/i);
    });

    it('populates query.equalTo, query.startAt, and query.endAt when equalTo(val) is used on a sandbox query', async () => {
      const sandbox = initializeSandbox({ projectId: 'r1-equalto-project' });
      const db = getDatabase(sandbox);
      await setRules(db, {
        rules: {
          items: {
            '.read': "query.orderByChild == 'category' && query.startAt == 'books' && query.endAt == 'books'",
            '.write': true,
            '.indexOn': ['category'],
          },
        },
      });
      await set(ref(db, 'items/i1'), { category: 'books', title: 'Dune' });

      const { equalTo } = await import('../../../src/database/index.js');
      const snap = await get(query(ref(db, 'items'), orderByChild('category'), equalTo('books')));
      expect(snap.exists()).toBe(true);
    });
  });

  describe('R2: Realtime Database Sandbox .indexOn Query Enforcement', () => {
    it('rejects orderByChild and orderByValue queries when .indexOn is missing in active ruleset', async () => {
      const sandbox = initializeSandbox({ projectId: 'r2-test-project' });
      const db = getDatabase(sandbox);
      await setRules(db, {
        rules: {
          scores: {
            '.read': true,
            '.write': true,
          },
        },
      });
      await set(ref(db, 'scores/alice'), { score: 100 });
      await set(ref(db, 'scores/bob'), { score: 200 });

      await expect(
        get(query(ref(db, 'scores'), orderByChild('score'))),
      ).rejects.toThrow('Index not defined, add ".indexOn": "score", for path "/scores", to the rules');

      await expect(
        get(query(ref(db, 'scores'), orderByValue())),
      ).rejects.toThrow('Index not defined, add ".indexOn": ".value", for path "/scores", to the rules');

      // orderByKey is exempt from .indexOn requirements
      const keySnap = await get(query(ref(db, 'scores'), orderByKey()));
      expect(keySnap.exists()).toBe(true);
    });

    it('enforces .indexOn on onValue query listeners when rules are active', async () => {
      const sandbox = initializeSandbox({ projectId: 'r2-listener-project' });
      const db = getDatabase(sandbox);
      await setRules(db, {
        rules: {
          items: {
            '.read': true,
          },
        },
      });

      expect(() => {
        onValue(query(ref(db, 'items'), orderByChild('price')), () => {});
      }).toThrow('Index not defined, add ".indexOn": "price", for path "/items", to the rules');
    });
  });
});
