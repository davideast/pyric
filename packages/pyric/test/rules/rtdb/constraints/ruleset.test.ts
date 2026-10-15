import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { ruleset } from '../../../../src/rules/rtdb/constraints/ruleset.js';
import { all, any, deny, always, expr } from '../../../../src/rules/rtdb/constraints/compose.js';
import { authenticated, ownPath, ownField, isNew } from '../../../../src/rules/rtdb/constraints/atoms.js';
import { ownerOrNew, pathOwnerOnly, hasRole, required } from '../../../../src/rules/rtdb/constraints/policies.js';

describe('ruleset()', () => {
  describe('declarative overload', () => {
    test('produces an environment-independent compiled tree', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
      });
      expect(compiled.path).toBe('/');
      expect(compiled).not.toHaveProperty('service');
      expect(compiled).not.toHaveProperty('databaseUrl');
    });

    test('root node has read/write expressions', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
      });
      const root = compiled;
      expect(root.path).toBe('/');
      expect(root.read?.raw).toBe('false');
      expect(root.write?.raw).toBe('false');
    });

    test('child paths become nested children', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
        '/users/$uid': {
          read: authenticated(),
          write: pathOwnerOnly('$uid'),
        },
      });
      const root = compiled;
      const usersNode = root.children.find(c => c.path === '/users');
      expect(usersNode).toBeDefined();
      const uidNode = usersNode!.children.find(c => c.path === '/users/$uid');
      expect(uidNode).toBeDefined();
      expect(uidNode!.read?.raw).toBe('auth != null');
      expect(uidNode!.pathVariables).toContain('$uid');
    });

    test('schema generates validate + child rules', () => {
      const compiled = ruleset({
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
      const root = compiled;
      const uidNode = root.children.find(c => c.path === '/users')!.children[0];
      // Parent has validate from schema
      expect(uidNode.validate?.raw).toContain('newData.hasChildren()');
      expect(uidNode.validate?.raw).toContain("newData.hasChild('name')");
      // Children have type checks
      const nameChild = uidNode.children.find(c => c.path.endsWith('/name'));
      expect(nameChild).toBeDefined();
      expect(nameChild!.validate?.raw).toBe('newData.isString()');
      const roleChild = uidNode.children.find(c => c.path.endsWith('/role'));
      expect(roleChild).toBeDefined();
      expect(roleChild!.validate?.raw).toContain("newData.val() == 'user'");
    });

    test('fieldConstraints merge with schema', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          write: ownerOrNew('author'),
          schema: z.object({ author: z.string() }),
          fieldConstraints: {
            author: [expr('newData.val() == auth.uid')],
          },
        },
      });
      const root = compiled;
      const postNode = root.children.find(c => c.path === '/posts')!.children[0];
      const authorChild = postNode.children.find(c => c.path.endsWith('/author'));
      expect(authorChild).toBeDefined();
      // Should be all(isString, authorEnforced)
      expect(authorChild!.validate?.raw).toContain('newData.isString()');
      expect(authorChild!.validate?.raw).toContain('newData.val() == auth.uid');
    });

    test('indexOn propagates to the collection node', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          write: authenticated(),
          indexOn: ['createdAt', 'author'],
        },
      });
      const root = compiled;
      const postsNode = root.children.find(c => c.path === '/posts');
      expect(postsNode?.indexOn).toEqual(['createdAt', 'author']);
    });

    test('indexOn on a non-wildcard path lands on that node directly', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny(), indexOn: ['.value'] },
        '/jobs': {
          read: authenticated(),
          write: authenticated(),
          indexOn: ['runAt'],
        },
      });
      expect(compiled.indexOn).toEqual(['.value']);
      const jobsNode = compiled.children.find(c => c.path === '/jobs');
      expect(jobsNode?.indexOn).toEqual(['runAt']);
      expect(jobsNode?.children).toEqual([]);
    });

    test('identical indexOn on parent and wildcard child is idempotent', () => {
      const compiled = ruleset({
        '/jobs': { read: authenticated(), indexOn: ['runAt'] },
        '/jobs/$jobId': { write: authenticated(), indexOn: ['runAt'] },
      });
      const jobsNode = compiled.children.find(c => c.path === '/jobs');
      expect(jobsNode?.indexOn).toEqual(['runAt']);
    });

    test('conflicting indexOn declarations targeting the same container throw', () => {
      expect(() =>
        ruleset({
          '/jobs': { read: authenticated(), indexOn: ['runAt'] },
          '/jobs/$jobId': { write: authenticated(), indexOn: ['priority'] },
        }),
      ).toThrow(/Conflicting indexOn declarations for "\/jobs"/);
    });

    test('explicit children nest correctly', () => {
      const compiled = ruleset({
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
      const root = compiled;
      const postNode = root.children.find(c => c.path === '/posts')!.children[0];
      const commentsNode = postNode.children.find(c => c.path.endsWith('/comments'));
      expect(commentsNode).toBeDefined();
      const commentNode = commentsNode!.children[0];
      expect(commentNode.path).toContain('/comments/$commentId');
      expect(commentNode.write?.raw).toBeDefined();
      expect(commentNode.validate?.raw).toContain('newData.hasChildren()');
    });

    test('normalizes trailing and duplicate slashes so rules are applied to the normalized node', () => {
      const trailing = ruleset({
        '/a/': { read: authenticated(), write: deny() },
      });
      const trailingNode = trailing.children.find(c => c.path === '/a');
      expect(trailingNode).toBeDefined();
      expect(trailingNode?.read?.raw).toBe('auth != null');
      expect(trailingNode?.write?.raw).toBe('false');

      const doubleSlash = ruleset({
        '//a': { read: authenticated(), write: deny() },
      });
      const doubleSlashNode = doubleSlash.children.find(c => c.path === '/a');
      expect(doubleSlashNode).toBeDefined();
      expect(doubleSlashNode?.read?.raw).toBe('auth != null');
      expect(doubleSlashNode?.write?.raw).toBe('false');
    });

    test('throws on duplicate normalized keys in record form', () => {
      expect(() =>
        ruleset({
          '/a': { read: deny() },
          '/a/': { write: always() },
        }),
      ).toThrow('Duplicate ruleset path declaration for "/a"');

      expect(() =>
        ruleset({
          '/a': { read: deny() },
          '//a': { write: always() },
        }),
      ).toThrow('Duplicate ruleset path declaration for "/a"');
    });

    test('throws when nested children collide with a top-level path', () => {
      expect(() =>
        ruleset({
          '/a': {
            read: deny(),
            children: {
              '/b': { read: deny(), write: deny() },
            },
          },
          '/a/b': { read: always() },
        }),
      ).toThrow('Duplicate ruleset path declaration for "/a/b"');
    });
  });

  describe('callback overload', () => {
    test('produces equivalent output', () => {
      const compiledObject = ruleset({
        '/': { read: deny(), write: deny() },
        '/users/$uid': { read: authenticated(), write: pathOwnerOnly('$uid') },
      });
      const compiledCallback = ruleset(({ path }) => {
        path('/', { read: deny(), write: deny() });
        path('/users/$uid', { read: authenticated(), write: pathOwnerOnly('$uid') });
      });
      const rootObj = compiledObject;
      const rootCb = compiledCallback;
      expect(rootObj.read?.raw).toBe(rootCb.read?.raw);
      expect(rootObj.children.length).toBe(rootCb.children.length);
    });

    test('throws on duplicate path declarations in callback form', () => {
      expect(() =>
        ruleset(({ path }) => {
          path('/a', { read: deny(), write: deny() });
          path('/a', { read: always() });
        }),
      ).toThrow('Duplicate ruleset path declaration for "/a"');
    });
  });

  describe('path variable extraction', () => {
    test('extracts $uid from /users/$uid', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
        '/users/$uid': { read: authenticated() },
      });
      const uidNode = (compiled).children[0].children[0];
      expect(uidNode.pathVariables).toContain('$uid');
    });

    test('extracts multiple variables', () => {
      const compiled = ruleset({
        '/': { read: deny(), write: deny() },
        '/posts/$postId': {
          read: always(),
          children: {
            '/comments/$commentId': { read: always() },
          },
        },
      });
      const postNode = (compiled).children[0].children[0];
      const commentNode = postNode.children[0].children[0];
      expect(commentNode.pathVariables).toContain('$postId');
      expect(commentNode.pathVariables).toContain('$commentId');
    });
  });
});
