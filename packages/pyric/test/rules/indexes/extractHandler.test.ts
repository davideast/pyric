/**
 * Unit tests for ExtractFirestoreIndexesHandler — the thin shell over
 * extractIndexes. Focus areas: input validation, paths→files reading,
 * pass-through of options, and read-failure error shape.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractFirestoreIndexesHandler } from '../../../src/rules/indexes/extractHandler.js';

describe('ExtractFirestoreIndexesHandler — input validation', () => {
  test('no files and no paths → recoverable EXTRACT_FAILED', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('EXTRACT_FAILED');
      expect(r.error.recoverable).toBe(true);
    }
  });

  test('empty arrays → recoverable EXTRACT_FAILED', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({ files: [], paths: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('EXTRACT_FAILED');
  });
});

describe('ExtractFirestoreIndexesHandler — files (inline) flow', () => {
  test('forwards files to extractIndexes and returns its result', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({
      files: [{
        name: 'a.js',
        source: 'function a(){ let q=query(collection(db,"r")); q=query(q,where("x","==",1),orderBy("y","desc")); }',
      }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.config.indexes).toHaveLength(1);
      expect(r.data.config.indexes[0].collectionGroup).toBe('r');
    }
  });

  test('queryVarName option is plumbed through', () => {
    const r = new ExtractFirestoreIndexesHandler().execute({
      files: [{
        name: 'a.js',
        source: 'function a(){ let myQ=query(collection(db,"r")); myQ=query(myQ,where("x","==",1),orderBy("y","desc")); }',
      }],
      queryVarName: 'myQ',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.config.indexes).toHaveLength(1);
  });
});

describe('ExtractFirestoreIndexesHandler — paths (filesystem) flow', () => {
  test('reads paths from disk and forwards source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-handler-'));
    const file = join(dir, 'sample.js');
    writeFileSync(
      file,
      'function fn(){ let q=query(collection(db,"posts")); q=query(q,where("authorId","==",a),orderBy("createdAt","desc")); }',
    );
    try {
      const r = new ExtractFirestoreIndexesHandler().execute({ paths: [file] });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.config.indexes).toHaveLength(1);
        expect(r.data.config.indexes[0].collectionGroup).toBe('posts');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing path → non-recoverable EXTRACT_FAILED with path in message', () => {
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

  test('mixed files + paths → both contribute to extraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-handler-'));
    const file = join(dir, 'b.js');
    writeFileSync(
      file,
      'function b(){ let q=query(collection(db,"r")); q=query(q,where("city","==",c),orderBy("price","asc")); }',
    );
    try {
      const r = new ExtractFirestoreIndexesHandler().execute({
        files: [{
          name: 'a.js',
          source: 'function a(){ let q=query(collection(db,"r")); q=query(q,where("category","==",c),orderBy("rating","desc")); }',
        }],
        paths: [file],
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.config.indexes).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
