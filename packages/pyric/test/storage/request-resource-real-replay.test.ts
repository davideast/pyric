/**
 * Real-resource replay: Storage `request.resource` fields.
 *
 * `stdlib-realstorage-request-resource-fields` records production verdicts for
 * probe rules deployed to a real bucket, under real client uploads (create),
 * metadata updates (update), and uploads over an existing object (overwrite).
 * It also records the content fields a client reads back after an upload, and
 * the verdicts of metadata updates over objects a client upload or the GCS
 * JSON API wrote. This suite deploys the same probe rules to a sandbox, makes
 * the same writes through the Storage SDK surface, and compares every verdict
 * and read-back with the capture.
 *
 * A probe whose sandbox verdict differs from production is listed in
 * KNOWN_DIVERGENCES with both verdicts pinned, so the suite fails when either
 * side changes.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getMetadata, getStorageSandbox, ref, updateMetadata, uploadBytes, type SettableMetadata,
} from '../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';
import {
  OBSERVATION_NAME,
  PROBE_GROUPS,
  PROBE_PAYLOAD,
  STORED_UPDATE_PROBES,
  STORED_UPDATE_SEEDS,
  STORED_UPLOADS,
  probePath,
  probeWrite,
  requestResourceRules,
  storedSeedPath,
  storedUpdatePath,
  storedUploadPath,
  type ProbeGroup,
  type StoredUpdateSeed,
} from '../../../conformance/src/storage-request-resource-probes.ts';

const OBSERVATION = join(
  import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'storage-rules', `${OBSERVATION_NAME}.json`,
);
const PREFIX = 'replay/request-resource';

type Verdict = 'ALLOW' | 'DENY';

const HASHES = 'The sandbox does not compute or persist md5Hash or crc32c, so request.resource does not carry them.';
const ETAG = 'The sandbox does not persist an etag, so a metadata update has none to carry.';
const STORAGE_CLASS = 'The sandbox does not model storage classes, so request.resource has no storageClass.';
const KEYS = 'request.resource lacks the unmodeled md5Hash, crc32c, and storageClass keys (and etag on a metadata update).';

const allowDenied = (reason: string) => ({ production: 'ALLOW' as const, sandbox: 'DENY' as const, reason });

const KNOWN_DIVERGENCES: Record<string, { production: Verdict; sandbox: Verdict; reason: string }> = {
  'create/present-md5Hash': allowDenied(HASHES),
  'create/present-crc32c': allowDenied(HASHES),
  'create/md5-string': allowDenied(HASHES),
  'create/crc32c-string': allowDenied(HASHES),
  'create/storage-class-null': allowDenied(STORAGE_CLASS),
  'create/extra-key-storageClass': allowDenied(STORAGE_CLASS),
  'create/keys-size-15': allowDenied(KEYS),
  'create/keys-documented-13': allowDenied(KEYS),
  'update/present-md5Hash': allowDenied(HASHES),
  'update/present-crc32c': allowDenied(HASHES),
  'update/md5-string': allowDenied(HASHES),
  'update/crc32c-string': allowDenied(HASHES),
  'update/md5-unchanged': allowDenied(HASHES),
  'update/crc32c-unchanged': allowDenied(HASHES),
  'update/present-etag': allowDenied(ETAG),
  'update/etag-string': allowDenied(ETAG),
  'update/etag-unchanged': allowDenied(ETAG),
  'update/storage-class-standard': allowDenied(STORAGE_CLASS),
  'update/extra-key-storageClass': allowDenied(STORAGE_CLASS),
  'update/keys-size-15': allowDenied(KEYS),
  'update/keys-documented-13': allowDenied(KEYS),
  'overwrite/present-md5Hash': allowDenied(HASHES),
  'overwrite/present-crc32c': allowDenied(HASHES),
  'overwrite/md5-changed': allowDenied(HASHES),
  'overwrite/keys-size-15': allowDenied(KEYS),
};

interface ContentFields { contentType: string | null; contentDisposition: string | null; contentEncoding: string | null }

interface Observation {
  behavior: Record<ProbeGroup, Record<string, Verdict>>;
  probeRules: string;
  storedObjects: Record<string, { gcs: ContentFields; client: ContentFields }>;
  storedUpdateBehavior: Record<StoredUpdateSeed, Record<string, Verdict>>;
}

function captured(): Observation {
  return JSON.parse(readFileSync(OBSERVATION, 'utf8'));
}

function probeStorages(label: string) {
  const sandbox = initializeSandbox({});
  const dbName = `pyric-request-resource-replay-${label}-${Math.random().toString(36).slice(2, 10)}`;
  const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {${requestResourceRules(PREFIX)}  }
}`;
  return {
    admin: getAdminStorageSandbox(sandbox, { dbName, rules }),
    client: getStorageSandbox(sandbox.withAuth(null), { dbName, rules }),
  };
}

function settable(fields: Record<string, unknown>): SettableMetadata {
  const { metadata, ...rest } = fields;
  return { ...rest, ...(metadata ? { customMetadata: metadata as Record<string, string> } : {}) };
}

async function sandboxVerdicts(group: ProbeGroup): Promise<Record<string, Verdict>> {
  const { admin, client } = probeStorages(group);
  const probes = PROBE_GROUPS.find((entry) => entry.group === group)!.probes;
  const verdicts: Record<string, Verdict> = {};
  for (const probe of probes) {
    const path = probePath(PREFIX, group, probe.id);
    if (group !== 'create') {
      // Production seeds through the GCS JSON API, which stores only a content type.
      await uploadBytes(ref(admin, path), PROBE_PAYLOAD, { contentType: 'application/octet-stream' });
    }
    const write = probeWrite(group, probe.id);
    verdicts[probe.id] = await verdictOf(write.kind === 'upload'
      ? uploadBytes(ref(client, path), write.bytes, settable(write.fields))
      : updateMetadata(ref(client, path), settable(write.fields)));
  }
  return verdicts;
}

async function verdictOf(write: Promise<unknown>): Promise<Verdict> {
  try {
    await write;
    return 'ALLOW';
  } catch (error) {
    if ((error as { code?: string }).code !== 'storage/unauthorized') throw error;
    return 'DENY';
  }
}

/** The content fields a client reads back, as the capture records them. */
async function clientReadBack(target: ReturnType<typeof ref>): Promise<ContentFields> {
  const metadata = await getMetadata(target);
  return {
    contentType: metadata.contentType ?? null,
    contentDisposition: metadata.contentDisposition ?? null,
    contentEncoding: metadata.contentEncoding ?? null,
  };
}

describe(`${OBSERVATION_NAME}: sandbox writes replay production request.resource verdicts`, () => {
  const observation = captured();

  it('replays the probe rules the capture deployed', () => {
    expect(requestResourceRules('<prefix>')).toBe(observation.probeRules);
  });

  for (const { group, probes } of PROBE_GROUPS) {
    it(`${group}: every probe matches production or a pinned divergence`, async () => {
      const production = observation.behavior[group];
      expect(Object.keys(production)).toEqual(probes.map((probe) => probe.id));
      const sandbox = await sandboxVerdicts(group);
      const mismatches: string[] = [];
      for (const probe of probes) {
        const key = `${group}/${probe.id}`;
        const pinned = KNOWN_DIVERGENCES[key];
        if (pinned) {
          expect({ key, production: production[probe.id], sandbox: sandbox[probe.id] })
            .toEqual({ key, production: pinned.production, sandbox: pinned.sandbox });
        } else if (sandbox[probe.id] !== production[probe.id]) {
          mismatches.push(`${key}: production ${production[probe.id]}, sandbox ${sandbox[probe.id]}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('a client reads back the content fields production stores for an upload', async () => {
    const { admin, client } = probeStorages('stored');
    const sandbox: Record<string, ContentFields> = {};
    for (const upload of STORED_UPLOADS) {
      const target = ref(client, storedUploadPath(PREFIX, upload));
      await uploadBytes(target, PROBE_PAYLOAD, settable(upload.fields));
      sandbox[upload.id] = await clientReadBack(target);
    }
    // The GCS JSON API stores only a content type, as the admin plane does.
    await uploadBytes(ref(admin, storedSeedPath(PREFIX)), PROBE_PAYLOAD, { contentType: 'application/octet-stream' });
    sandbox['gcs-json-api-seed'] = await clientReadBack(ref(client, storedSeedPath(PREFIX)));
    const production = Object.fromEntries(
      Object.entries(observation.storedObjects).map(([id, views]) => [id, views.client]),
    );
    expect(sandbox).toEqual(production);
  });

  it('a metadata update over a client-uploaded or admin-written object matches production', async () => {
    const { admin, client } = probeStorages('stored-update');
    const sandbox: Record<StoredUpdateSeed, Record<string, Verdict>> = { client: {}, gcs: {} };
    for (const seed of STORED_UPDATE_SEEDS) {
      for (const probe of STORED_UPDATE_PROBES) {
        const path = storedUpdatePath(PREFIX, seed, probe.id);
        await uploadBytes(ref(seed === 'gcs' ? admin : client, path), PROBE_PAYLOAD, {
          contentType: seed === 'gcs' ? 'application/octet-stream' : 'text/plain',
        });
        sandbox[seed][probe.id] = await verdictOf(updateMetadata(ref(client, path), { customMetadata: { probe: 'value' } }));
      }
    }
    expect(sandbox).toEqual(observation.storedUpdateBehavior);
  });
});
