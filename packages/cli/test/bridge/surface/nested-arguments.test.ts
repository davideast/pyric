import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const surface = renderSurface(undefined);

let projectDir: string;
let sandbox: ReturnType<typeof initializeSandbox>;
let ctx: SurfaceContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-nested-args-'));
  sandbox = initializeSandbox();
  setRules(sandbox, OPEN_FIRESTORE_RULES);
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  sandbox.dispose();
  rmSync(projectDir, { recursive: true, force: true });
});

async function call(
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

describe('nested argument validation and SetOptions / UploadMetadata support (#1922)', () => {
  it('refuses firestore.setDoc options.mrege before running the handler', async () => {
    await call('firestore.setDoc', {
      path: 'users/alice',
      data: { role: 'viewer', keep: true },
    });

    const rejected = await call('firestore.setDoc', {
      path: 'users/alice',
      data: { role: 'admin' },
      options: { mrege: true },
    });
    expect(rejected.ok).toBe(false);
    expect((rejected.data as { code?: string; field?: string }).code).toBe('invalid_arguments');
    expect((rejected.data as { field?: string }).field).toBe('options.mrege');
    expect((rejected.data as { fix?: string }).fix).toContain('options.merge');

    const unchanged = await call('firestore.getDoc', { path: 'users/alice' });
    expect((unchanged.data as { data: unknown }).data).toEqual({
      role: 'viewer',
      keep: true,
    });
  });

  it('honors firestore.setDoc options.mergeFields for top-level, dotted, and sentinel fields', async () => {
    await call('sandbox.setClock', { isoTime: '2026-09-09T12:00:00.000Z' });
    await call('firestore.setDoc', {
      path: 'users/bob',
      data: {
        role: 'viewer',
        untouched: 'stay',
        profile: { name: 'Bob', city: 'NYC' },
      },
    });

    const merged = await call('firestore.setDoc', {
      path: 'users/bob',
      data: {
        role: 'editor',
        ignoredField: 'dropped',
        profile: { name: 'Robert', city: 'LA' },
        updatedAt: { $serverTimestamp: true },
      },
      options: { mergeFields: ['role', 'profile.name', 'updatedAt'] },
    });
    expect(merged.ok).toBe(true);

    const read = await call('firestore.getDoc', { path: 'users/bob' });
    expect((read.data as { data: Record<string, unknown> }).data).toEqual({
      role: 'editor',
      untouched: 'stay',
      profile: { name: 'Robert', city: 'NYC' },
      updatedAt: {
        seconds: Date.parse('2026-09-09T12:00:00.000Z') / 1000,
        nanoseconds: 0,
      },
    });
  });

  it('validates nested options and honors mergeFields in firestore.writeBatch', async () => {
    await call('firestore.setDoc', {
      path: 'users/carol',
      data: { role: 'viewer', keep: 1 },
    });

    const typoBatch = await call('firestore.writeBatch', {
      writes: [
        {
          type: 'set',
          path: 'users/carol',
          data: { role: 'admin' },
          options: { mrege: true },
        },
      ],
    });
    expect(typoBatch.ok).toBe(false);
    expect((typoBatch.data as { field?: string }).field).toBe('writes.0.options.mrege');

    const okBatch = await call('firestore.writeBatch', {
      writes: [
        {
          type: 'set',
          path: 'users/carol',
          data: { role: 'admin', ignored: 99 },
          options: { mergeFields: ['role'] },
        },
      ],
    });
    expect(okBatch.ok).toBe(true);

    const read = await call('firestore.getDoc', { path: 'users/carol' });
    expect((read.data as { data: unknown }).data).toEqual({ role: 'admin', keep: 1 });
  });

  it('refuses unknown nested keys on storage.uploadBytes and storage.updateMetadata and honors metadata.cacheControl', async () => {
    const badUpload = await call('storage.uploadBytes', {
      path: 'uploads/bad.txt',
      contentBase64: 'aGVsbG8=',
      metadata: { contentTyp: 'text/plain' },
    });
    expect(badUpload.ok).toBe(false);
    expect((badUpload.data as { code?: string; field?: string }).code).toBe('invalid_arguments');
    expect((badUpload.data as { field?: string }).field).toBe('metadata.contentTyp');
    expect((badUpload.data as { fix?: string }).fix).toContain('metadata.contentType');

    const missing = await call('storage.getMetadata', { path: 'uploads/bad.txt' });
    expect(missing.ok).toBe(false);

    const uploaded = await call('storage.uploadBytes', {
      path: 'uploads/good.txt',
      contentBase64: 'aGVsbG8=',
      metadata: {
        contentType: 'text/plain',
        cacheControl: 'public, max-age=300',
        contentDisposition: 'inline',
        contentLanguage: 'en',
        customMetadata: { arbitraryKey: 'preserved' },
      },
    });
    expect(uploaded.ok).toBe(true);

    const metaAfterUpload = await call('storage.getMetadata', { path: 'uploads/good.txt' });
    expect(metaAfterUpload.ok).toBe(true);
    const storedMeta = (metaAfterUpload.data as { metadata: Record<string, unknown> }).metadata;
    expect(storedMeta.cacheControl).toBe('public, max-age=300');
    expect(storedMeta.contentDisposition).toBe('inline');
    expect(storedMeta.contentLanguage).toBe('en');
    expect(storedMeta.contentType).toBe('text/plain');
    expect(storedMeta.customMetadata).toEqual({ arbitraryKey: 'preserved' });

    const badUpdate = await call('storage.updateMetadata', {
      path: 'uploads/good.txt',
      metadata: { cacheControll: 'no-store' },
    });
    expect(badUpdate.ok).toBe(false);
    expect((badUpdate.data as { code?: string; field?: string }).code).toBe('invalid_arguments');
    expect((badUpdate.data as { field?: string }).field).toBe('metadata.cacheControll');
    expect((badUpdate.data as { fix?: string }).fix).toContain('metadata.cacheControl');

    const metaAfterRejectedUpdate = await call('storage.getMetadata', { path: 'uploads/good.txt' });
    expect(
      (metaAfterRejectedUpdate.data as { metadata: Record<string, unknown> }).metadata.cacheControl,
    ).toBe('public, max-age=300');
  });

  it('preserves method-specific nested answers (sandbox.seed users.claims) and union query messages', async () => {
    const seedRejected = await call('sandbox.seed', {
      users: [{ uid: 'u1', claims: { role: 'admin' } }],
    });
    expect(seedRejected.ok).toBe(false);
    expect((seedRejected.data as { field?: string }).field).toBe('users.claims');
    expect(seedRejected.summary).toContain("'customClaims'");

    const queryMismatch = await call('rules.simulate', {
      service: 'firestore',
      operation: 'list',
      path: 'users',
      query: { orderByChild: 'age' },
    });
    expect(queryMismatch.ok).toBe(false);
    expect(queryMismatch.summary).toContain('Realtime Database query');

    const queryTypo = await call('rules.simulate', {
      service: 'firestore',
      operation: 'list',
      path: 'users',
      query: { limti: 5 },
    });
    expect(queryTypo.ok).toBe(false);
    expect((queryTypo.data as { field?: string }).field).toBe('query.limti');
  });
});
