/**
 * Unit tests for ExtractFirestoreIndexesHandler: input validation, inline
 * `files`, disk `paths` (single files and directories), and browser-clean
 * execution without `globalThis.process`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractFirestoreIndexesHandler } from '../../src/indexes/extractHandler.js';

describe('ExtractFirestoreIndexesHandler: input validation', () => {
  test('no files and no paths returns recoverable EXTRACT_FAILED', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('EXTRACT_FAILED');
      expect(r.error.recoverable).toBe(true);
    }
  });

  test('empty arrays return recoverable EXTRACT_FAILED', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({ files: [], paths: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('EXTRACT_FAILED');
  });
});

describe('ExtractFirestoreIndexesHandler: inline files and browser mode', () => {
  test('forwards files to extractIndexes and supports arbitrary query variable names', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({
      files: [
        {
          name: 'a.js',
          source:
            'function a(){ let myQ=query(collection(db,"r")); myQ=query(myQ,where("x","==",1),orderBy("y","desc")); }',
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.config.indexes).toHaveLength(1);
      expect(r.data.config.indexes[0].collectionGroup).toBe('r');
    }
  });

  test('runs inline files cleanly when globalThis.process is undefined and rejects paths recoverably', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const inlineResult = new ExtractFirestoreIndexesHandler().execute({
        files: [
          {
            name: 'src/app.ts',
            source: `
              import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
              declare const db: unknown;
              export const run = () => getDocs(query(collection(db, 'items'), where('a', '==', 1), orderBy('b', 'desc')));
            `,
          },
        ],
      });
      expect(inlineResult.success).toBe(true);
      if (inlineResult.success) {
        expect(inlineResult.data.config.indexes).toHaveLength(1);
      }

      const diskResult = new ExtractFirestoreIndexesHandler().execute({ paths: ['src'] });
      expect(diskResult.success).toBe(false);
      if (!diskResult.success) {
        expect(diskResult.error.code).toBe('EXTRACT_FAILED');
        expect(diskResult.error.recoverable).toBe(true);
      }
    } finally {
      if (saved) Object.defineProperty(globalThis, 'process', saved);
    }
  });
});

describe('ExtractFirestoreIndexesHandler: filesystem paths', () => {
  test('reads single file paths and directory trees with cross-file helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-handler-'));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'filters.ts'),
      `import { orderBy, query, where, type Query } from 'firebase/firestore';
       export const withAuthorSort = (q: Query, a: string) => query(q, where('authorId', '==', a), orderBy('createdAt', 'desc'));`,
    );
    writeFileSync(
      join(srcDir, 'posts.ts'),
      `import { collection, getDocs, query } from 'firebase/firestore';
       import { withAuthorSort } from './filters';
       declare const db: unknown;
       export const loadPosts = (a: string) => getDocs(withAuthorSort(query(collection(db, 'posts')), a));`,
    );
    try {
      const r = new ExtractFirestoreIndexesHandler().execute({ paths: [srcDir] });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.config.indexes).toHaveLength(1);
        expect(r.data.config.indexes[0].collectionGroup).toBe('posts');
        expect(r.data.warnings).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing path returns non-recoverable EXTRACT_FAILED with path in message', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({
      paths: ['/no/such/file/exists/here.js'],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('EXTRACT_FAILED');
      expect(r.error.recoverable).toBe(false);
      expect(r.error.message).toContain('/no/such/file/exists/here.js');
    }
  });

  test('mixed files and paths both contribute to extraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-handler-'));
    const file = join(dir, 'b.js');
    writeFileSync(
      file,
      'function b(){ let q=query(collection(db,"r")); q=query(q,where("city","==",c),orderBy("price","asc")); }',
    );
    try {
      const r = new ExtractFirestoreIndexesHandler().execute({
        files: [
          {
            name: 'a.js',
            source:
              'function a(){ let q=query(collection(db,"r")); q=query(q,where("category","==",c),orderBy("rating","desc")); }',
          },
        ],
        paths: [file],
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.config.indexes).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves tsconfig path aliases, sibling ../lib helpers on scoped paths, and mixed relative file + directory paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-handler-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'extract-handler-outside-'));
    try {
      mkdirSync(join(dir, 'src/lib'), { recursive: true });
      mkdirSync(join(dir, 'src/pages'), { recursive: true });
      mkdirSync(join(dir, 'src/other'), { recursive: true });
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@/*': ['src/*'] },
          },
        }),
      );
      writeFileSync(
        join(dir, 'src/lib/filters.ts'),
        `
          import { collection, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          export const publishedArticles = (topic: string) =>
            query(collection(db, 'articles'), where('topic', '==', topic), orderBy('publishedAt', 'desc'));
        `,
      );
      writeFileSync(
        join(dir, 'src/lib/sibling.ts'),
        `
          import { collection, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          export const openTickets = (team: string) =>
            query(collection(db, 'tickets'), where('team', '==', team), orderBy('priority', 'desc'));
        `,
      );
      writeFileSync(
        join(dir, 'src/pages/feed.ts'),
        `
          import { getDocs } from 'firebase/firestore';
          import { publishedArticles } from '@/lib/filters';
          import { openTickets } from '../lib/sibling';
          export const loadFeed = (topic: string, team: string) =>
            Promise.all([getDocs(publishedArticles(topic)), getDocs(openTickets(team))]);
        `,
      );
      writeFileSync(
        join(dir, 'src/other/unused.ts'),
        `
          import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          export const unrelated = () =>
            getDocs(query(collection(db, 'unrelated'), where('x', '==', 1), orderBy('y', 'desc')));
        `,
      );
      writeFileSync(
        join(outsideDir, 'secret.ts'),
        `
          import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          export const secret = () =>
            getDocs(query(collection(db, 'leaked'), where('a', '==', 1), orderBy('b', 'desc')));
        `,
      );
      symlinkSync(join(outsideDir, 'secret.ts'), join(dir, 'src/pages/secret-link.ts'));

      const scopedDir = new ExtractFirestoreIndexesHandler().execute({
        paths: [join(dir, 'src/pages')],
      });
      expect(scopedDir.success).toBe(true);
      if (scopedDir.success) {
        expect(scopedDir.data.warnings).toEqual([]);
        expect(scopedDir.data.config.indexes.map((i) => i.collectionGroup).sort()).toEqual([
          'articles',
          'tickets',
        ]);
      }

      const singleFile = new ExtractFirestoreIndexesHandler().execute({
        paths: ['src/pages/feed.ts'],
        projectDir: dir,
      });
      expect(singleFile.success).toBe(true);
      if (singleFile.success) {
        expect(singleFile.data.warnings).toEqual([]);
        expect(singleFile.data.config.indexes.map((i) => i.collectionGroup).sort()).toEqual([
          'articles',
          'tickets',
        ]);
      }

      const mixedRelAndDir = new ExtractFirestoreIndexesHandler().execute({
        paths: ['src/pages/feed.ts', 'src/lib'],
        projectDir: dir,
      });
      expect(mixedRelAndDir.success).toBe(true);
      if (mixedRelAndDir.success) {
        expect(mixedRelAndDir.data.warnings).toEqual([]);
        expect(mixedRelAndDir.data.config.indexes.map((i) => i.collectionGroup).sort()).toEqual([
          'articles',
          'tickets',
        ]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
