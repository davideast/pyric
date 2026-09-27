import { describe, test, expect } from 'bun:test';
import { buildSimulatedAuth, buildContext } from '../../../src/rules/simulator/handler-context.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { Path } from '../../../src/rules/simulator/wrappers/path.js';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';

describe('handler-context', () => {
  describe('buildSimulatedAuth', () => {
    test('returns null when auth is absent or null', () => {
      expect(buildSimulatedAuth(undefined)).toBeNull();
      expect(buildSimulatedAuth(null as any)).toBeNull();
    });

    test('normalizes auth token claims for a standard auth user', () => {
      const auth = buildSimulatedAuth({
        uid: 'user_123',
        email: 'alice@example.com',
      } as any);

      expect(auth).not.toBeNull();
      expect(auth!.uid).toBe('user_123');
      const token = auth!.token as Record<string, unknown>;
      expect(token.sub).toBe('user_123');
      expect(token.user_id).toBe('user_123');
      expect(token.email).toBe('alice@example.com');
      const fb = token.firebase as Record<string, unknown>;
      expect(fb.sign_in_provider).toBe('custom');
    });

    test('normalizes tenant auth context when tenant is present', () => {
      const auth = buildSimulatedAuth({
        uid: 'user_tenant',
        tenant: 'tenant-42',
      } as any);

      expect(auth).not.toBeNull();
      expect(auth!.uid).toBe('user_tenant');
      expect(auth!.tenant).toBe('tenant-42');
      const token = auth!.token as Record<string, unknown>;
      const fb = token.firebase as Record<string, unknown>;
      expect(fb.tenant).toBe('tenant-42');
    });
  });

  describe('buildContext', () => {
    test('constructs simulation context with path wrapper and timestamp', () => {
      const tc: TestCase = {
        description: 'basic read',
        expectation: 'ALLOW',
        method: 'get',
        path: 'users/alice',
        requestTime: '2026-01-01T00:00:00Z',
      };

      const ctx = buildContext(tc, [], { userId: 'alice' });

      expect(ctx.database).toBe('(default)');
      expect(ctx.pathVariables).toEqual({ userId: 'alice' });
      expect(ctx.request.method).toBe('get');
      expect(ctx.request.path).toBeInstanceOf(Path);
      expect(ctx.request.time).toBeInstanceOf(Timestamp);
      expect(ctx.request.time.toMillis()).toBe(new Date('2026-01-01T00:00:00Z').getTime());
      expect(ctx.request.query).toBeUndefined();
    });

    test('populates query on list operation when query options provided', () => {
      const tc: TestCase = {
        description: 'list query',
        expectation: 'ALLOW',
        method: 'list',
        path: 'items',
        query: {
          limit: 10,
        },
      };

      const ctx = buildContext(tc, [], {});
      expect(ctx.request.query).toBeDefined();
      expect(ctx.request.query!.limit).toBe(10);
    });

    test('builds mockDocuments and identitylessFunctionMocks from functionMocks', () => {
      const tc: TestCase = {
        description: 'function mock get and exists',
        expectation: 'ALLOW',
        method: 'get',
        path: 'orders/1',
        functionMocks: [
          {
            function: 'get',
            path: 'users/alice',
            result: { name: 'Alice', age: 30 },
          },
          {
            function: 'exists',
            path: 'settings/global',
            result: true,
          },
        ],
      };

      const ctx = buildContext(tc, [], {});
      expect(ctx.mockDocuments.has('users/alice')).toBe(true);
      expect(ctx.mockDocuments.get('users/alice')).toEqual({ name: 'Alice', age: 30 });
      expect(ctx.mockDocuments.has('settings/global')).toBe(true);
      expect(ctx.identitylessFunctionMocks.has('users/alice')).toBe(true);
      expect(ctx.identitylessFunctionMocks.has('settings/global')).toBe(true);
    });

    test('projects afterState on create and update', () => {
      const createTc: TestCase = {
        description: 'create item',
        expectation: 'ALLOW',
        method: 'create',
        path: 'items/item1',
        data: { title: 'New Item' },
      };

      const createCtx = buildContext(createTc, [], {});
      expect(createCtx.resource).toBeNull();
      expect(createCtx.existsAfter).toBe(true);
      expect(createCtx.afterState).toEqual({ title: 'New Item' });

      const updateTc: TestCase = {
        description: 'update item',
        expectation: 'ALLOW',
        method: 'update',
        path: 'items/item1',
        resource: { title: 'Old Title', count: 1 },
        data: { title: 'New Title', count: 2 },
      };

      const updateCtx = buildContext(updateTc, [], {});
      expect(updateCtx.resource).toEqual({ data: { title: 'Old Title', count: 1 } });
      expect(updateCtx.existsAfter).toBe(true);
      expect(updateCtx.afterState).toEqual({ title: 'New Title', count: 2 });
    });

    test('projects afterState null on delete', () => {
      const deleteTc: TestCase = {
        description: 'delete item',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'items/item1',
        resource: { title: 'To Delete' },
      };

      const deleteCtx = buildContext(deleteTc, [], {});
      expect(deleteCtx.resource).toEqual({ data: { title: 'To Delete' } });
      expect(deleteCtx.existsAfter).toBe(false);
      expect(deleteCtx.afterState).toBeNull();
    });

    test('preserves batchProjection when supplied', () => {
      const tc: TestCase = {
        description: 'batch item',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/item1',
      };
      const batchMap = new Map<string, Record<string, unknown> | null>([
        ['items/item1', { title: 'Batch Item' }],
      ]);

      const ctx = buildContext(tc, [], {}, undefined, batchMap);
      expect(ctx.batchProjection).toBe(batchMap);
    });
  });
});
