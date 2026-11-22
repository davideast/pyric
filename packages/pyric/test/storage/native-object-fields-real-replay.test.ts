/**
 * Real-resource replay: `stdlib-realstorage-p2-native-object-fields` (#3258).
 *
 * Deploys the exact `nativeRules` probe rules from
 * `packages/conformance/src/run-storage-stdlib-native-fields.ts` onto a sandbox
 * bucket, executes the same reads, creates, metadata updates, and byte
 * overwrites through the Storage SDK surface, and asserts every verdict and
 * post-mutation relation matches the committed production observation. Also
 * verifies callers cannot forge `md5Hash`, `crc32c`, or `etag` through mutable
 * metadata inputs.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  getMetadata,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  type UploadMetadata,
} from '../../src/storage/index.js';
import {
  getAdminStorageSandbox,
  getStorageService,
  replaceStorageRules,
} from '../../src/storage/internal.js';
import { nativeRules } from '../../../conformance/src/run-storage-stdlib-native-fields.ts';
import type { GcsObject } from '../../../conformance/src/storage-stdlib-real-objects.ts';

type Verdict = 'ALLOW' | 'DENY';

interface NativeObservation {
  behavior: Record<string, unknown>;
}

const OBSERVATION_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'storage-rules',
  'stdlib-realstorage-p2-native-object-fields.json',
);

const PAYLOAD = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
const REPLACEMENT = new Uint8Array([0x72, 0x75, 0x6c, 0x65, 0x73]);

const SEED_NAMES = [
  'stored-exact',
  'identity-mismatch',
  'hash-mismatch',
  'time-mismatch',
  'metadata-update',
  'byte-overwrite-control',
  'byte-overwrite-md5',
  'byte-overwrite-crc',
] as const;

async function verdictOf(op: Promise<unknown>): Promise<Verdict> {
  try {
    await op;
    return 'ALLOW';
  } catch (error) {
    if ((error as { code?: string }).code !== 'storage/unauthorized') {
      throw error;
    }
    return 'DENY';
  }
}

describe('stdlib-realstorage-p2-native-object-fields: sandbox replays production verdicts and relations (#3258)', () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as NativeObservation;

  it('matches every read, incoming create, metadata-update, and byte-overwrite verdict and relation', async () => {
    const sandbox = initializeSandbox({});
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 9, 30, 15, 44, 27, 397));
    const dbName = `pyric-native-fields-${Math.random().toString(36).slice(2, 10)}`;
    const openRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } }
}`;
    const admin = getAdminStorageSandbox(sandbox, { dbName, rules: openRules });
    const client = getStorageSandbox(sandbox.withAuth(null), { dbName, rules: openRules });
    const service = await getStorageService(admin);

    const runId = 'replay3258';
    const nativePrefix = `__pyric_storage_stdlib/${runId}/native`;
    const serverMetadata: Record<string, GcsObject> = {};

    for (const name of SEED_NAMES) {
      const path = `${nativePrefix}/${name}.bin`;
      await uploadBytes(ref(admin, path), PAYLOAD, { contentType: 'application/octet-stream' });
      const stored = await service.backend.getMetadata(path);
      if (!stored || !stored.md5Hash || !stored.crc32c || !stored.etag) {
        throw new Error(`Missing stored metadata for ${path}`);
      }
      serverMetadata[name] = {
        name: stored.fullPath,
        bucket: stored.bucket,
        generation: stored.generation,
        metageneration: stored.metageneration,
        size: String(stored.size),
        md5Hash: stored.md5Hash,
        crc32c: stored.crc32c,
        etag: stored.etag,
        timeCreated: stored.timeCreated,
        updated: stored.updated,
      };
    }

    const deployedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {${nativeRules(runId, serverMetadata)}  }
}`;
    await replaceStorageRules(sandbox, deployedRules);

    const actual: Record<string, unknown> = {};
    expect(await verdictOf(uploadBytes(ref(client, `${nativePrefix}/canary.bin`), PAYLOAD))).toBe('ALLOW');

    for (const family of ['stored-exact', 'identity-mismatch', 'hash-mismatch', 'time-mismatch']) {
      actual[family] = await verdictOf(getMetadata(ref(client, `${nativePrefix}/${family}.bin`)));
    }

    for (const family of [
      'incoming-exact',
      'incoming-md5-mismatch',
      'incoming-crc-mismatch',
      'incoming-excluded-version',
      'incoming-excluded-etag',
      'incoming-excluded-time',
    ]) {
      actual[family] = await verdictOf(uploadBytes(ref(client, `${nativePrefix}/${family}.bin`), PAYLOAD));
    }

    clock.advance(1_000);
    const metadataPath = `${nativePrefix}/metadata-update.bin`;
    actual['metadata-update'] = await verdictOf(
      updateMetadata(ref(client, metadataPath), { customMetadata: { probe: runId } }),
    );
    const metadataAfter = await service.backend.getMetadata(metadataPath);
    const metadataBefore = serverMetadata['metadata-update'];
    if (!metadataBefore) {
      throw new Error('Missing seeded metadata for metadata-update');
    }
    actual['metadata-update-relations'] = {
      generationPreserved: metadataAfter?.generation === metadataBefore.generation,
      hashesPreserved:
        metadataAfter?.md5Hash === metadataBefore.md5Hash &&
        metadataAfter?.crc32c === metadataBefore.crc32c,
      timeCreatedPreserved: metadataAfter?.timeCreated === metadataBefore.timeCreated,
      metagenerationAdvanced: Number(metadataAfter?.metageneration) > Number(metadataBefore.metageneration),
      updatedAdvanced: Date.parse(metadataAfter?.updated ?? '') > Date.parse(metadataBefore.updated),
    };

    for (const family of ['byte-overwrite-control', 'byte-overwrite-md5', 'byte-overwrite-crc']) {
      clock.advance(1_000);
      const path = `${nativePrefix}/${family}.bin`;
      actual[family] = await verdictOf(uploadBytes(ref(client, path), REPLACEMENT));
      const overwriteAfter = await service.backend.getMetadata(path);
      const overwriteBefore = serverMetadata[family];
      if (!overwriteBefore) {
        throw new Error(`Missing seeded metadata for ${family}`);
      }
      actual[`${family}-relations`] = {
        generationAdvanced: Number(overwriteAfter?.generation) > Number(overwriteBefore.generation),
        md5Changed: overwriteAfter?.md5Hash !== overwriteBefore.md5Hash,
        crc32cChanged: overwriteAfter?.crc32c !== overwriteBefore.crc32c,
        timeCreatedAdvanced:
          Date.parse(overwriteAfter?.timeCreated ?? '') >= Date.parse(overwriteBefore.timeCreated),
      };
    }

    expect(actual).toEqual(observation.behavior);
  });

  it('ignores caller attempts to forge md5Hash, crc32c, or etag through upload or update metadata inputs', async () => {
    const sandbox = initializeSandbox({});
    const dbName = `pyric-no-forge-${Math.random().toString(36).slice(2, 10)}`;
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /forge/item.bin {
      allow create: if request.resource.md5Hash == 'forged-md5'
        || request.resource.crc32c == 'forged-crc'
        || request.resource.etag == 'forged-etag';
      allow update: if request.resource.md5Hash == 'forged-md5'
        || request.resource.crc32c == 'forged-crc'
        || request.resource.etag == 'forged-etag';
    }
  }
}`;
    const admin = getAdminStorageSandbox(sandbox, { dbName, rules });
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules });

    const forgedInput = {
      contentType: 'application/octet-stream',
      md5Hash: 'forged-md5',
      crc32c: 'forged-crc',
      etag: 'forged-etag',
    } as unknown as UploadMetadata;

    expect(await verdictOf(uploadBytes(ref(client, 'forge/item.bin'), PAYLOAD, forgedInput))).toBe('DENY');

    await uploadBytes(ref(admin, 'forge/item.bin'), PAYLOAD, { contentType: 'application/octet-stream' });
    expect(await verdictOf(updateMetadata(ref(client, 'forge/item.bin'), forgedInput))).toBe('DENY');
  });
});
