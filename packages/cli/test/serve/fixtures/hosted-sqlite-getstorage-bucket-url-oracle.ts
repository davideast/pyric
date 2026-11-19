import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';

interface RecordedCallOutcome {
  readonly threw: boolean;
  readonly code: string | null;
}

interface RecordedRefOutcome extends RecordedCallOutcome {
  readonly bucket: string | null;
  readonly fullPath: string | null;
  readonly name: string | null;
  readonly toStringValue: string | null;
}

interface RecordedBucketSpellingCase {
  readonly getStorageOutcome: RecordedCallOutcome;
  readonly rootRef: RecordedRefOutcome | null;
  readonly childRef: RecordedRefOutcome | null;
}

interface ObservedSpellingProjection {
  readonly getStorageThrew: boolean;
  readonly getStorageCode: string | null;
  readonly rootRef: {
    readonly threw: boolean;
    readonly code: string | null;
    readonly bucket: string | null;
    readonly fullPath: string | null;
    readonly name: string | null;
    readonly toStringValue: string | null;
  } | null;
  readonly childRef: {
    readonly threw: boolean;
    readonly code: string | null;
    readonly bucket: string | null;
    readonly fullPath: string | null;
    readonly name: string | null;
    readonly toStringValue: string | null;
  } | null;
}

function projectRecordedSpelling(recorded: RecordedBucketSpellingCase): ObservedSpellingProjection {
  let rootRef: ObservedSpellingProjection['rootRef'] = null;
  if (recorded.rootRef !== null) {
    rootRef = {
      threw: recorded.rootRef.threw,
      code: recorded.rootRef.code,
      bucket: recorded.rootRef.bucket,
      fullPath: recorded.rootRef.fullPath,
      name: recorded.rootRef.name,
      toStringValue: recorded.rootRef.toStringValue,
    };
  }
  let childRef: ObservedSpellingProjection['childRef'] = null;
  if (recorded.childRef !== null) {
    childRef = {
      threw: recorded.childRef.threw,
      code: recorded.childRef.code,
      bucket: recorded.childRef.bucket,
      fullPath: recorded.childRef.fullPath,
      name: recorded.childRef.name,
      toStringValue: recorded.childRef.toStringValue,
    };
  }
  return {
    getStorageThrew: recorded.getStorageOutcome.threw,
    getStorageCode: recorded.getStorageOutcome.code,
    rootRef,
    childRef,
  };
}

const obsFile = new URL(
  '../../../src/../../conformance/observations/storage/client-storage-getstorage-bucket-url.json',
  import.meta.url,
);
const obs = (JSON.parse(readFileSync(obsFile, 'utf8')) as { behavior: Record<string, unknown> }).behavior;

const directory = realpathSync(process.argv[2] ?? '.');
const SESSION = 'session-token-s11-bucket-url-oracle';
const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/__pyric/init.json') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        bridgeUrl: '/__pyric/sandbox',
        hosted: true,
        projectKey: directory,
        sessionToken: SESSION,
      }),
    );
    return;
  }
  void mount.handler(request, response, url).then((handled) => {
    if (!handled) response.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

await mount.startHostedSandbox(
  {
    rules: null,
    rulesHash: null,
    storageRules: OPEN_RULES,
    storageRulesHash: 'open-s11',
    storageBucketRules: {
      'buckets-default': { rules: OPEN_RULES, rulesHash: 'open-s11' },
      'media-bucket': { rules: OPEN_RULES, rulesHash: 'open-s11' },
    },
    bridgeUrl: '/__pyric/sandbox',
    seed: null,
    capture: false,
    hosted: true,
    projectKey: directory,
    sessionToken: SESSION,
  },
  base,
);
mount.attachHost({
  servers: [server],
  projectDir: directory,
  origin: () => ({ host: '127.0.0.1', port: address.port }),
});

process.env.PYRIC_LIVE_PROJECT_ROOT = directory;
process.env.PYRIC_SANDBOX = `remote:${base}`;
process.env.PYRIC_SESSION_TOKEN = SESSION;

const clientApp = await import('../../../src/register/client/app.js');
const clientStorage = await import('../../../src/register/client/storage.js');

const configuredApp = clientApp.initializeApp(
  { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
  'hosted-configured',
);
const secondaryApp = clientApp.initializeApp(
  { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
  'hosted-secondary',
);
const retryProbeApp = clientApp.initializeApp(
  { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
  'hosted-retry',
);

function observeRef(
  storage: ReturnType<typeof clientStorage.getStorage>,
  path?: string,
): NonNullable<ObservedSpellingProjection['rootRef']> {
  let reference = clientStorage.ref(storage);
  if (path !== undefined) {
    reference = clientStorage.ref(storage, path);
  }
  return {
    threw: false,
    code: null,
    bucket: reference.bucket,
    fullPath: reference.fullPath,
    name: reference.name,
    toStringValue: reference.toString(),
  };
}

function observeSpelling(
  targetApp: typeof configuredApp,
  bucketUrl?: string,
): ObservedSpellingProjection {
  let storage: ReturnType<typeof clientStorage.getStorage>;
  try {
    if (bucketUrl === undefined) {
      storage = clientStorage.getStorage(targetApp);
    } else {
      storage = clientStorage.getStorage(targetApp, bucketUrl);
    }
  } catch (error) {
    assert.ok(error instanceof clientStorage.StorageError);
    let code: string | null = null;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string') {
        code = candidate;
      }
    }
    return {
      getStorageThrew: true,
      getStorageCode: code,
      rootRef: null,
      childRef: null,
    };
  }
  return {
    getStorageThrew: false,
    getStorageCode: null,
    rootRef: observeRef(storage),
    childRef: observeRef(storage, 'items/a.txt'),
  };
}

try {
  const defaultHandle = clientStorage.getStorage(configuredApp);
  const ownGsHandle = clientStorage.getStorage(configuredApp, 'gs://buckets-default');
  const ownGsSlashHandle = clientStorage.getStorage(configuredApp, 'gs://buckets-default/');
  const ownBareHandle = clientStorage.getStorage(configuredApp, 'buckets-default');
  const emptyBucketUrlHandle = clientStorage.getStorage(configuredApp, '');
  const otherGsHandle = clientStorage.getStorage(configuredApp, 'gs://media-bucket');
  const otherGsSlashHandle = clientStorage.getStorage(configuredApp, 'gs://media-bucket/');
  const otherBareHandle = clientStorage.getStorage(configuredApp, 'media-bucket');
  const secondaryOtherGsHandle = clientStorage.getStorage(secondaryApp, 'gs://media-bucket');

  const retryDefault = clientStorage.getStorage(retryProbeApp);
  const retryOwnGs = clientStorage.getStorage(retryProbeApp, 'gs://buckets-default');
  retryOwnGs.maxOperationRetryTime = 45_000;

  assert.deepEqual(
    {
      appMatches: defaultHandle.app === configuredApp && otherGsHandle.app === configuredApp,
      defaultMaxOperationRetryTime: defaultHandle.maxOperationRetryTime,
      defaultMaxUploadRetryTime: defaultHandle.maxUploadRetryTime,
      repeatDefaultSameHandle: defaultHandle === clientStorage.getStorage(configuredApp),
      repeatEmptyStringSameHandle:
        emptyBucketUrlHandle === clientStorage.getStorage(configuredApp, ''),
      repeatOwnGsSameHandle:
        ownGsHandle === clientStorage.getStorage(configuredApp, 'gs://buckets-default'),
      repeatOtherGsSameHandle:
        otherGsHandle === clientStorage.getStorage(configuredApp, 'gs://media-bucket'),
      defaultEqualsEmptyString: defaultHandle === emptyBucketUrlHandle,
      defaultEqualsOwnGs: defaultHandle === ownGsHandle,
      defaultEqualsOwnGsSlash: defaultHandle === ownGsSlashHandle,
      defaultEqualsOwnBare: defaultHandle === ownBareHandle,
      ownGsEqualsOwnGsSlash: ownGsHandle === ownGsSlashHandle,
      ownGsEqualsOwnBare: ownGsHandle === ownBareHandle,
      otherGsEqualsOtherGsSlash: otherGsHandle === otherGsSlashHandle,
      otherGsEqualsOtherBare: otherGsHandle === otherBareHandle,
      otherAppSameGsDistinctHandle: otherGsHandle !== secondaryOtherGsHandle,
      retryMutationOnOwnGsLeavesDefaultUnchanged:
        retryOwnGs.maxOperationRetryTime === 45_000 &&
        retryDefault.maxOperationRetryTime === 120_000,
    },
    obs.configuredHandles,
  );

  const recordedSpellings = obs.configuredBucketSpellings as Record<
    string,
    RecordedBucketSpellingCase
  >;
  const actualSpellings: Record<string, ObservedSpellingProjection> = {
    omitted: observeSpelling(configuredApp),
    emptyString: observeSpelling(configuredApp, ''),
    ownGs: observeSpelling(configuredApp, 'gs://buckets-default'),
    ownGsTrailingSlash: observeSpelling(configuredApp, 'gs://buckets-default/'),
    ownBare: observeSpelling(configuredApp, 'buckets-default'),
    otherGs: observeSpelling(configuredApp, 'gs://media-bucket'),
    otherGsTrailingSlash: observeSpelling(configuredApp, 'gs://media-bucket/'),
    otherBare: observeSpelling(configuredApp, 'media-bucket'),
    firebaseRootDownloadUrl: observeSpelling(
      configuredApp,
      'https://firebasestorage.googleapis.com/v0/b/media-bucket/o',
    ),
    cloudStorageRootUrl: observeSpelling(
      configuredApp,
      'https://storage.googleapis.com/media-bucket',
    ),
  };
  for (const [key, expectedCase] of Object.entries(recordedSpellings)) {
    assert.deepEqual(actualSpellings[key], projectRecordedSpelling(expectedCase));
  }

  const recordedInvalid = obs.invalidBucketUrls as Record<string, RecordedBucketSpellingCase>;
  const actualInvalid: Record<string, ObservedSpellingProjection> = {
    gsWithObjectPath: observeSpelling(configuredApp, 'gs://media-bucket/sub/path'),
    firebaseObjectDownloadUrl: observeSpelling(
      configuredApp,
      'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/items%2Fa.txt',
    ),
    cloudStorageObjectUrl: observeSpelling(
      configuredApp,
      'https://storage.googleapis.com/media-bucket/items/a.txt',
    ),
  };
  for (const [key, expectedCase] of Object.entries(recordedInvalid)) {
    assert.deepEqual(actualInvalid[key], projectRecordedSpelling(expectedCase));
  }

  const defaultUploaded = await clientStorage.uploadBytes(
    clientStorage.ref(defaultHandle, 'items/hosted-shared.bin'),
    new Uint8Array([10, 20, 30]),
  );
  assert.equal(defaultUploaded.metadata.bucket, 'buckets-default');
  const ownGsMeta = await clientStorage.getMetadata(
    clientStorage.ref(ownGsHandle, 'items/hosted-shared.bin'),
  );
  assert.equal(ownGsMeta.bucket, 'buckets-default');

  await assert.rejects(
    clientStorage.getMetadata(clientStorage.ref(otherGsHandle, 'items/hosted-shared.bin')),
    (error: Error & { code?: string }) => error.code === 'storage/object-not-found',
  );

  const mediaUploaded = await clientStorage.uploadBytes(
    clientStorage.ref(otherGsHandle, 'items/hosted-media.bin'),
    new Uint8Array([40, 50]),
  );
  assert.equal(mediaUploaded.metadata.bucket, 'media-bucket');
  const mediaBareMeta = await clientStorage.getMetadata(
    clientStorage.ref(otherBareHandle, 'items/hosted-media.bin'),
  );
  assert.equal(mediaBareMeta.bucket, 'media-bucket');
  const mediaBytes = new Uint8Array(
    await clientStorage.getBytes(clientStorage.ref(otherBareHandle, 'items/hosted-media.bin')),
  );
  assert.deepEqual([...mediaBytes], [40, 50]);

  const undeployedHandle = clientStorage.getStorage(configuredApp, 'gs://undeployed-bucket');
  await assert.rejects(
    clientStorage.uploadBytes(
      clientStorage.ref(undeployedHandle, 'items/denied.bin'),
      new Uint8Array([1]),
    ),
    (error: Error & { code?: string }) => error.code === 'storage/unauthorized',
  );

  console.log('GetStorage bucketUrl oracle replay passed');
} finally {
  await Promise.all([
    clientApp.deleteApp(configuredApp),
    clientApp.deleteApp(secondaryApp),
    clientApp.deleteApp(retryProbeApp),
  ]);
  await mount.close();
  server.close();
}
