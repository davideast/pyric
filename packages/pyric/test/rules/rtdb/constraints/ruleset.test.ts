import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { ruleset } from '../../../../src/rules/rtdb/constraints/ruleset.js';
import { all, any, deny, always, expr } from '../../../../src/rules/rtdb/constraints/compose.js';
import { authenticated, ownPath, ownField, isNew } from '../../../../src/rules/rtdb/constraints/atoms.js';
import { ownerOrNew, pathOwnerOnly, hasRole, required } from '../../../../src/rules/rtdb/constraints/policies.js';
import type { RtdbNode } from '../../../../src/rules/rtdb/types.js';

const URL = 'https://test-db.firebaseio.com';

describe('ruleset()', () => {
  describe('declarative overload', () => {
    test('produces valid RtdbIR', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
      });
      expect(ir.service).toBe('realtime-database');
      expect(ir.databaseUrl).toBe(URL);
      expect(ir.rules).toBeDefined();
    });

    test('root node has read/write expressions', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
      });
      const root = ir.rules as RtdbNode;
      expect(root.path).toBe('/');
      expect(root.read?.raw).toBe('false');
      expect(root.write?.raw).toBe('false');
    });

    test('child paths become nested children', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/users/$uid': {
          read: authenticated(),
          write: pathOwnerOnly('$uid'),
        },
      });
      const root = ir.rules as RtdbNode;
      const usersNode = root.children.find(c => c.path === '/users');
      expect(usersNode).toBeDefined();
      const uidNode = usersNode!.children.find(c => c.path === '/users/$uid');
      expect(uidNode).toBeDefined();
      expect(uidNode!.read?.raw).toBe('auth !== null');
      expect(uidNode!.pathVariables).toContain('$uid');
    });

    test('schema generates validate + child rules', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/users/$uid': {
          read: authenticated(),
          write: pathOwnerOnly('$uid'),
          schema: z.object({
            name: z.string(),
            role: z.enum(['user', 'admin']),
          }),
        },
      });
      const root = ir.rules as RtdbNode;
      const uidNode = root.children.find(c => c.path === '/users')!.children[0];
      // Parent has validate from schema
      expect(uidNode.validate?.raw).toContain('newData.hasChildren()');
      expect(uidNode.validate?.raw).toContain('newData.hasChild("name")');
      // Children have type checks
      const nameChild = uidNode.children.find(c => c.path.endsWith('/name'));
      expect(nameChild).toBeDefined();
      expect(nameChild!.validate?.raw).toBe('newData.isString()');
      const roleChild = uidNode.children.find(c => c.path.endsWith('/role'));
      expect(roleChild).toBeDefined();
      expect(roleChild!.validate?.raw).toContain('newData.val() === "user"');
    });

    test('fieldConstraints merge with schema', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          write: ownerOrNew('author'),
          schema: z.object({ author: z.string() }),
          fieldConstraints: {
            author: [expr('newData.val() === auth.uid')],
          },
        },
      });
      const root = ir.rules as RtdbNode;
      const postNode = root.children.find(c => c.path === '/posts')!.children[0];
      const authorChild = postNode.children.find(c => c.path.endsWith('/author'));
      expect(authorChild).toBeDefined();
      // Should be all(isString, authorEnforced)
      expect(authorChild!.validate?.raw).toContain('newData.isString()');
      expect(authorChild!.validate?.raw).toContain('newData.val() === auth.uid');
    });

    test('indexOn propagates to the collection node', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          write: authenticated(),
          indexOn: ['createdAt', 'author'],
        },
      });
      const root = ir.rules as RtdbNode;
      const postsNode = root.children.find(c => c.path === '/posts');
      expect(postsNode?.indexOn).toEqual(['createdAt', 'author']);
    });

    test('explicit children nest correctly', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          write: ownerOrNew('author'),
          children: {
            '/comments/$commentId': {
              write: ownerOrNew('author'),
              schema: z.object({ text: z.string(), author: z.string() }),
            },
          },
        },
      });
      const root = ir.rules as RtdbNode;
      const postNode = root.children.find(c => c.path === '/posts')!.children[0];
      const commentsNode = postNode.children.find(c => c.path.endsWith('/comments'));
      expect(commentsNode).toBeDefined();
      const commentNode = commentsNode!.children[0];
      expect(commentNode.path).toContain('/comments/$commentId');
      expect(commentNode.write?.raw).toBeDefined();
      expect(commentNode.validate?.raw).toContain('newData.hasChildren()');
    });
  });

  describe('callback overload', () => {
    test('produces equivalent output', () => {
      const irObj = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/users/$uid': { read: authenticated(), write: pathOwnerOnly('$uid') },
      });
      const irCb = ruleset(URL, ({ path }) => {
        path('/', { read: deny(), write: deny() });
        path('/users/$uid', { read: authenticated(), write: pathOwnerOnly('$uid') });
      });
      const rootObj = irObj.rules as RtdbNode;
      const rootCb = irCb.rules as RtdbNode;
      expect(rootObj.read?.raw).toBe(rootCb.read?.raw);
      expect(rootObj.children.length).toBe(rootCb.children.length);
    });
  });

  describe('path variable extraction', () => {
    test('extracts $uid from /users/$uid', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/users/$uid': { read: authenticated() },
      });
      const uidNode = (ir.rules as RtdbNode).children[0].children[0];
      expect(uidNode.pathVariables).toContain('$uid');
    });

    test('extracts multiple variables', () => {
      const ir = ruleset(URL, {
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          children: {
            '/comments/$commentId': { read: always() },
          },
        },
      });
      const postNode = (ir.rules as RtdbNode).children[0].children[0];
      const commentNode = postNode.children[0].children[0];
      expect(commentNode.pathVariables).toContain('$postId');
      expect(commentNode.pathVariables).toContain('$commentId');
    });
  });
});
