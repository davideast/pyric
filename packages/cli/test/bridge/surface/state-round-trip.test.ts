/**
 * What survives a round trip, for both ways the surface saves the sandbox.
 *
 * A fixture and a checkpoint are two envelopes over the same state, and the
 * failure they share is a quiet one: a field nobody carried reads back empty
 * and the run continues on state that is not the state that was saved. So this
 * suite writes one sandbox that holds something for every service, sends it
 * through each envelope, and reads every field back: documents, database
 * values, storage bytes with their content type and custom metadata, users
 * with their tenant and claims, and all three rule sources.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getActiveRules } from 'pyric/sandbox/database';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, getStorageRulesResolution } from 'pyric/storage/internal';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const DATABASE_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

const CONTENT_BASE64 = Buffer.from('a fixture carries these bytes', 'utf8').toString('base64');

const surface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

async function run(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

/** Every field this suite holds the two envelopes to, read off the live sandbox. */
async function liveState(): Promise<Record<string, unknown>> {
  const document = await run('firestore.getDoc', { path: 'ledger/entry' });
  const value = await run('database.get', { path: 'ledger/entry' });
  const bytes = await run('storage.getBytes', { path: 'uploads/report.txt' });
  const stored = await run('storage.getMetadata', { path: 'uploads/report.txt' });
  // Generation and timestamps are the store's own record of when the object
  // was written, and a restore writes it again, so they are not round-tripped.
  const { metadata } = stored.data as {
    metadata: { contentType?: string; customMetadata?: unknown };
  };
  const user = authSandbox.exportUsers(getAuth(sandbox)).find((each) => each.uid === 'alice');
  return {
    document: (document.data as { data: unknown }).data,
    value: (value.data as { value: unknown }).value,
    bytes: (bytes.data as { contentBase64: string }).contentBase64,
    contentType: metadata.contentType,
    customMetadata: metadata.customMetadata,
    tenantId: user?.tenantId,
    customClaims: user?.customClaims,
    firestoreRules: getInternalEnv(sandbox).getRules(),
    databaseRules: getActiveRules(sandbox),
    storageRules: getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source ?? null,
  };
}

/** One sandbox holding something for every service, written through the surface. */
async function seedEveryService(): Promise<void> {
  expect(
    (
      await run('sandbox.seed', {
        firestoreRules: FIRESTORE_RULES,
        databaseRules: DATABASE_RULES,
        storageRules: STORAGE_RULES,
        users: [{ uid: 'alice', email: 'alice@example.com', tenantId: 'tenant-a', customClaims: { role: 'owner' } }],
        firestore: { 'ledger/entry': { amount: 12 } },
        database: { ledger: { entry: 'recorded' } },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await run('storage.uploadBytes', {
        path: 'uploads/report.txt',
        contentBase64: CONTENT_BASE64,
        metadata: {
          contentType: 'text/plain',
          customMetadata: { author: 'alice', reviewed: 'yes' },
        },
      })
    ).ok,
  ).toBe(true);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-round-trip-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

it('carries every service through a fixture, a reset, and a seed back', async () => {
  await seedEveryService();
  const before = await liveState();

  expect((await run('sandbox.exportFixture', { path: 'fixtures/every-service.json' })).ok).toBe(
    true,
  );
  expect((await run('sandbox.reset', { confirm: true })).ok).toBe(true);
  expect((await run('sandbox.seedFromFixture', { path: 'fixtures/every-service.json' })).ok).toBe(
    true,
  );

  expect(await liveState()).toEqual(before);
});

it('carries every service through a checkpoint and a restore', async () => {
  await seedEveryService();
  const before = await liveState();

  expect((await run('sandbox.checkpoint', { name: 'every-service' })).ok).toBe(true);
  expect((await run('sandbox.reset', { confirm: true })).ok).toBe(true);
  expect((await run('sandbox.restore', { name: 'every-service', confirm: true })).ok).toBe(true);

  expect(await liveState()).toEqual(before);
});
