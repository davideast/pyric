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
  limitToFirst,
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

    it('accepts the query identifier in .read, .write and .validate rules, as production deploy does', () => {
      for (const kind of ['read', 'write', 'validate'] as const) {
        expect(validateExpression("query.orderByChild == 'timestamp'", kind, [])).toHaveLength(0);
      }
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

    it('delivers unindexed listener queries filtered locally and warns when the query is limited', async () => {
      const sandbox = initializeSandbox({ projectId: 'r2-listener-project' });
      const db = getDatabase(sandbox);
      await setRules(db, {
        rules: {
          items: {
            '.read': true,
            '.write': true,
          },
        },
      });
      await set(ref(db, 'items'), { a: { price: 3 }, b: { price: 1 }, c: { price: 2 } });

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      try {
        const limited: unknown[] = [];
        const stopLimited = onValue(query(ref(db, 'items'), orderByChild('price'), limitToFirst(2)), (snap) => {
          limited.push(snap.val());
        });
        stopLimited();
        expect(limited).toEqual([{ b: { price: 1 }, c: { price: 2 } }]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^\[[^\]]+\] {2}@firebase\/database: FIREBASE WARNING: Using an unspecified index\. Your data will be downloaded and filtered on the client\. Consider adding "\.indexOn": "price" at \/items to your security rules for better performance\. $/);

        warnings.length = 0;
        const unlimited: unknown[] = [];
        const stopUnlimited = onValue(query(ref(db, 'items'), orderByChild('price')), (snap) => {
          unlimited.push(snap.val());
        });
        stopUnlimited();
        expect(unlimited).toHaveLength(1);
        expect(warnings).toEqual([]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});
