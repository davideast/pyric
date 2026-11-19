/**
 * The `bucket` argument every object-plane `storage` method takes: a bare
 * bucket name, a root `gs://` or Firebase Storage download URL, or `default`,
 * resolved against the sandbox's default bucket and per-bucket Security Rules.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getBytes, getMetadata, listAll, ref, uploadBytes } from 'pyric/storage';
import { deployStorageBucketRules, getAdminStorageSandbox, nameStorageBucket } from 'pyric/storage/internal';

import { TargetRouter } from '../../../../../src/bridge/server/target-router.js';
import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { callMethod } from '../../../../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';

const DEFAULT_SURFACE = renderSurface(undefined);
const DISCRIMINATOR_SURFACE = renderSurface('discriminator');
const VERB_PREFIXED_SURFACE = renderSurface('verb-prefixed');
const DEFAULT_BUCKET_NAME = 'demo-app.appspot.com';
const MEDIA_BUCKET = 'surface-media-bucket';
const ARCHIVE_BUCKET = 'surface-archive-bucket';

const DEFAULT_BYTES = new TextEncoder().encode('default-body');
const MEDIA_BYTES = new TextEncoder().encode('media-payload');
const UPLOADED_BASE64 = Buffer.from('fresh-media').toString('base64');

let nextRun = 0;

/** A fresh sandbox context with distinct objects on the default bucket and `media-bucket`. */
async function seeded(): Promise<{ ctx: SurfaceContext; prefix: string }> {
  nextRun += 1;
  const prefix = `run-${nextRun}`;
  const sandbox = initializeSandbox();
  const ctx = createSurfaceContext(sandbox);
  ctx.storageBucketName = () => DEFAULT_BUCKET_NAME;

  const defaultAdmin = nameStorageBucket(getAdminStorageSandbox(sandbox), DEFAULT_BUCKET_NAME);
  const mediaAdmin = nameStorageBucket(
    getAdminStorageSandbox(sandbox, { bucket: MEDIA_BUCKET }),
    MEDIA_BUCKET,
  );

  await uploadBytes(ref(defaultAdmin, `${prefix}/item.txt`), DEFAULT_BYTES, {
    contentType: 'text/plain',
    customMetadata: { tier: 'default' },
  });
  await uploadBytes(ref(defaultAdmin, `${prefix}/extra.txt`), DEFAULT_BYTES, {
    contentType: 'text/plain',
  });
  await uploadBytes(ref(mediaAdmin, `${prefix}/item.txt`), MEDIA_BYTES, {
    contentType: 'text/plain',
    customMetadata: { tier: 'media' },
  });

  return { ctx, prefix };
}

async function call(
  ctx: SurfaceContext,
  key: string,
  args: Record<string, unknown>,
): Promise<OperationResult> {
  const parts = key.split('.');
  const toolName = parts[0] ?? '';
  const method = parts[1] ?? '';
  const tool = DEFAULT_SURFACE.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

async function listedPaths(ctx: SurfaceContext, prefix: string, bucket?: string): Promise<string[]> {
  let handle = getAdminStorageSandbox(ctx.sandbox);
  if (bucket !== undefined) {
    handle = getAdminStorageSandbox(ctx.sandbox, { bucket });
  }
  const listing = await listAll(ref(handle, prefix));
  return listing.items.map((item) => item.fullPath).sort();
}

interface MethodCase {
  method: string;
  buildArgs(prefix: string): Record<string, unknown>;
  assertReachedMedia(result: OperationResult, ctx: SurfaceContext, prefix: string): Promise<void>;
}

const CASES: MethodCase[] = [
  {
    method: 'getBytes',
    buildArgs: (prefix) => ({ path: `${prefix}/item.txt` }),
    assertReachedMedia: async (result, _ctx, prefix) => {
      expect(result.summary).toBe(`Downloaded ${prefix}/item.txt (${MEDIA_BYTES.byteLength} bytes) on ${MEDIA_BUCKET}`);
      expect(result.data).toEqual({
        path: `${prefix}/item.txt`,
        size: MEDIA_BYTES.byteLength,
        contentBase64: Buffer.from(MEDIA_BYTES).toString('base64'),
      });
    },
  },
  {
    method: 'getDownloadURL',
    buildArgs: (prefix) => ({ path: `${prefix}/item.txt` }),
    assertReachedMedia: async (result, _ctx, prefix) => {
      expect(result.summary).toBe(`Minted a download URL for ${prefix}/item.txt on ${MEDIA_BUCKET}`);
      const returned = result.data as { path: string; url: string };
      expect(returned.path).toBe(`${prefix}/item.txt`);
      expect(returned.url.startsWith('data:text/plain')).toBe(true);
      expect(returned.url.endsWith(`;base64,${Buffer.from(MEDIA_BYTES).toString('base64')}`)).toBe(true);
    },
  },
  {
    method: 'getMetadata',
    buildArgs: (prefix) => ({ path: `${prefix}/item.txt` }),
    assertReachedMedia: async (result, _ctx, prefix) => {
      expect(result.summary).toBe(`Read metadata for ${prefix}/item.txt on ${MEDIA_BUCKET}`);
      const metadata = (result.data as { metadata: { bucket: string; size: number; customMetadata?: Record<string, string> } }).metadata;
      expect(metadata.bucket).toBe(MEDIA_BUCKET);
      expect(metadata.size).toBe(MEDIA_BYTES.byteLength);
      expect(metadata.customMetadata).toEqual({ tier: 'media' });
    },
  },
  {
    method: 'listAll',
    buildArgs: (prefix) => ({ prefix }),
    assertReachedMedia: async (result, _ctx, prefix) => {
      expect(result.summary).toBe(`1 objects under ${prefix} on ${MEDIA_BUCKET}`);
      expect(result.data).toEqual({ items: [`${prefix}/item.txt`], prefixes: [] });
    },
  },
  {
    method: 'uploadBytes',
    buildArgs: (prefix) => ({ path: `${prefix}/new.txt`, contentBase64: UPLOADED_BASE64 }),
    assertReachedMedia: async (result, ctx, prefix) => {
      expect(result.summary).toBe(`Uploaded ${prefix}/new.txt (11 bytes) on ${MEDIA_BUCKET}`);
      const mediaHandle = getAdminStorageSandbox(ctx.sandbox, { bucket: MEDIA_BUCKET });
      const storedBytes = await getBytes(ref(mediaHandle, `${prefix}/new.txt`));
      expect(new TextDecoder().decode(storedBytes)).toBe('fresh-media');
      expect(await listedPaths(ctx, prefix)).toEqual([`${prefix}/extra.txt`, `${prefix}/item.txt`]);
    },
  },
  {
    method: 'updateMetadata',
    buildArgs: (prefix) => ({
      path: `${prefix}/item.txt`,
      metadata: { cacheControl: 'max-age=120', customMetadata: { tier: 'updated-media' } },
    }),
    assertReachedMedia: async (result, ctx, prefix) => {
      expect(result.summary).toBe(`Updated the metadata on ${prefix}/item.txt on ${MEDIA_BUCKET}`);
      const updated = (result.data as { metadata: { bucket: string; cacheControl?: string } }).metadata;
      expect(updated.bucket).toBe(MEDIA_BUCKET);
      expect(updated.cacheControl).toBe('max-age=120');
      const defaultMeta = await getMetadata(ref(getAdminStorageSandbox(ctx.sandbox), `${prefix}/item.txt`));
      expect(defaultMeta.customMetadata).toEqual({ tier: 'default' });
    },
  },
  {
    method: 'deleteObject',
    buildArgs: (prefix) => ({ path: `${prefix}/item.txt` }),
    assertReachedMedia: async (result, ctx, prefix) => {
      expect(result.summary).toBe(`Deleted ${prefix}/item.txt on ${MEDIA_BUCKET}`);
      expect(await listedPaths(ctx, prefix, MEDIA_BUCKET)).toEqual([]);
      expect(await listedPaths(ctx, prefix)).toEqual([`${prefix}/extra.txt`, `${prefix}/item.txt`]);
    },
  },
];

const MEDIA_BUCKET_FORMS = [
  MEDIA_BUCKET,
  `gs://${MEDIA_BUCKET}`,
  `gs://${MEDIA_BUCKET}/`,
  `https://firebasestorage.googleapis.com/v0/b/${MEDIA_BUCKET}/o`,
  `https://firebasestorage.googleapis.com/v0/b/${MEDIA_BUCKET}/o/`,
];

describe('every object-plane storage method selects the bucket it names', () => {
  for (const testCase of CASES) {
    describe(`storage.${testCase.method}`, () => {
      it.each(MEDIA_BUCKET_FORMS)(
        'reaches the bucket named as %s and leaves the default bucket alone',
        async (form) => {
          const { ctx, prefix } = await seeded();
          const result = await call(ctx, `storage.${testCase.method}`, {
            ...testCase.buildArgs(prefix),
            bucket: form,
          });
          expect(result.ok).toBe(true);
          await testCase.assertReachedMedia(result, ctx, prefix);
        },
      );

      it('declares bucket in its signature', () => {
        expect(methodByKey(`storage.${testCase.method}`).signature).toContain('bucket?');
      });
    });
  }
});

describe('the default bucket', () => {
  it.each([
    'default',
    'DEFAULT',
    DEFAULT_BUCKET_NAME,
    `gs://${DEFAULT_BUCKET_NAME}`,
    `gs://${DEFAULT_BUCKET_NAME}/`,
  ])('is selected by %s without appending a bucket suffix to summary', async (form) => {
    const { ctx, prefix } = await seeded();
    const result = await call(ctx, 'storage.getBytes', {
      path: `${prefix}/item.txt`,
      bucket: form,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(`Downloaded ${prefix}/item.txt (${DEFAULT_BYTES.byteLength} bytes)`);
    expect(result.data).toEqual({
      path: `${prefix}/item.txt`,
      size: DEFAULT_BYTES.byteLength,
      contentBase64: Buffer.from(DEFAULT_BYTES).toString('base64'),
    });
  });

  it('is what a call with no bucket reaches', async () => {
    const { ctx, prefix } = await seeded();
    const result = await call(ctx, 'storage.listAll', { prefix });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(`2 objects under ${prefix}`);
    expect(result.data).toEqual({
      items: [`${prefix}/extra.txt`, `${prefix}/item.txt`],
      prefixes: [],
    });
  });
});

describe('bucket argument renames and validation', () => {
  it.each(['bucketId', 'bucketUrl', 'storageBucket'])(
    'guides renamed bucket spelling %s onto bucket',
    async (alias) => {
      const { ctx, prefix } = await seeded();
      const result = await call(ctx, 'storage.getMetadata', {
        path: `${prefix}/item.txt`,
        [alias]: MEDIA_BUCKET,
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('bucket');
      expect((result.data as { code: string })).toMatchObject({ code: 'invalid_arguments' });
    },
  );

  it.each([
    ['gs://media-bucket/uploads/a.txt', 'storage/invalid-default-bucket'],
    ['https://firebasestorage.googleapis.com/v0/b/media-bucket/o/uploads%2Fa.txt', 'storage/invalid-default-bucket'],
    ['media-bucket/secret', 'not a Cloud Storage bucket'],
    ['', 'not a Cloud Storage bucket'],
  ])('rejects malformed bucket %p before the handler', async (bucket, expectedText) => {
    const { ctx, prefix } = await seeded();
    const result = await call(ctx, 'storage.getBytes', { path: `${prefix}/item.txt`, bucket });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(expectedText);
    expect((result.data as { code: string; field: string })).toMatchObject({
      code: 'invalid_arguments',
      field: 'bucket',
    });
  });
});

describe('per-bucket Security Rules under a uid identity', () => {
  const ALICE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == 'alice' && bucket == '${MEDIA_BUCKET}';
    }
  }
}`;
  const BOB_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == 'bob';
    }
  }
}`;

  it('enforces the selected bucket rules and locks undeployed buckets', async () => {
    const { ctx, prefix } = await seeded();
    deployStorageBucketRules(ctx.sandbox, DEFAULT_BUCKET_NAME, BOB_RULES);
    deployStorageBucketRules(ctx.sandbox, MEDIA_BUCKET, ALICE_RULES);

    expect((await call(ctx, 'auth.createUser', { uid: 'alice', email: 'alice@example.com' })).ok).toBe(true);
    expect((await call(ctx, 'auth.impersonate', { uid: 'alice' })).ok).toBe(true);

    const deniedDefault = await call(ctx, 'storage.uploadBytes', {
      path: `${prefix}/alice.txt`,
      contentBase64: UPLOADED_BASE64,
    });
    expect(deniedDefault.ok).toBe(false);
    expect(deniedDefault.summary).toContain('storage/unauthorized');

    const allowedMedia = await call(ctx, 'storage.uploadBytes', {
      path: `${prefix}/alice.txt`,
      contentBase64: UPLOADED_BASE64,
      bucket: `gs://${MEDIA_BUCKET}`,
    });
    expect(allowedMedia.ok).toBe(true);

    const lockedUndeployed = await call(ctx, 'storage.uploadBytes', {
      path: `${prefix}/alice.txt`,
      contentBase64: UPLOADED_BASE64,
      bucket: ARCHIVE_BUCKET,
    });
    expect(lockedUndeployed.ok).toBe(false);
    expect(lockedUndeployed.summary).toContain('storage/unauthorized');
  });
});

describe('rendered MCP variants and target router', () => {
  it('forwards bucket across discriminator and one-tool-per-method surfaces', async () => {
    const { ctx, prefix } = await seeded();
    const manageTool = DISCRIMINATOR_SURFACE.tools.find(
      (candidate) => candidate.name === 'manage_storage_files',
    );
    if (manageTool === undefined) throw new Error('missing manage_storage_files tool');

    const uploaded = await manageTool.execute(
      {
        action: 'upload',
        bucket: `gs://${MEDIA_BUCKET}`,
        path: `${prefix}/disc.txt`,
        base64Content: UPLOADED_BASE64,
      },
      ctx,
    );
    expect(uploaded.ok).toBe(true);

    const listed = await manageTool.execute(
      { action: 'list', bucket: MEDIA_BUCKET, path: prefix },
      ctx,
    );
    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual({
      items: [`${prefix}/disc.txt`, `${prefix}/item.txt`],
      prefixes: [],
    });

    const verbTool = VERB_PREFIXED_SURFACE.tools.find(
      (candidate) => candidate.name === 'download_storage_file',
    );
    if (verbTool === undefined) throw new Error('missing download_storage_file tool');
    const downloaded = await verbTool.execute(
      { path: `${prefix}/disc.txt`, bucket: MEDIA_BUCKET },
      ctx,
    );
    expect(downloaded.ok).toBe(true);
    expect((downloaded.data as { contentBase64: string }).contentBase64).toBe(UPLOADED_BASE64);
  });

  it('hands the hosted call the bucket argument unchanged', async () => {
    const { ctx, prefix } = await seeded();
    const received: Array<Record<string, unknown>> = [];
    ctx.targetRouter = new TargetRouter({
      projectDir: ctx.projectDir,
      discover: async () => ({
        url: 'http://127.0.0.1:1',
        base: 'http://127.0.0.1:1',
        mcpUrl: 'http://127.0.0.1:1/__pyric/mcp',
        instanceId: 'host',
        source: 'pointer .pyric/serve.json',
      }),
      callHosted: async (_host, _key, args) => {
        received.push(args);
        return { ok: true, summary: `Read metadata for ${prefix}/item.txt on ${MEDIA_BUCKET}` };
      },
    });
    const args = { path: `${prefix}/item.txt`, bucket: `gs://${MEDIA_BUCKET}` };
    const result = await callMethod(methodByKey('storage.getMetadata'), args, ctx);
    expect(result.summary).toContain(`Read metadata for ${prefix}/item.txt on ${MEDIA_BUCKET}`);
    expect(received).toEqual([{ ...args, __pyricCallerIdentity: { mode: 'default' } }]);
  });
});
