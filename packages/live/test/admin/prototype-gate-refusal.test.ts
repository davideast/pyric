import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { Duplex, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { observeAdminAppCheck } from '../../src/admin/app-check.js';
import { observeAdminAuth } from '../../src/admin/auth.js';
import { observeAdminDatabase } from '../../src/admin/database.js';
import { observeAdminFirestore } from '../../src/admin/firestore.js';
import { observeAdminMessaging } from '../../src/admin/messaging.js';
import { adminProjectGate } from '../../src/admin/project-gate.js';
import { observeAdminStorage } from '../../src/admin/storage.js';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';

const HOST_PROJECT = 'canary-host-project';
const OTHER_PROJECT = 'canary-other-project';
const HOST_BUCKET = `${HOST_PROJECT}.appspot.com`;
const OTHER_BUCKET = `${OTHER_PROJECT}.appspot.com`;
const IS_ISOLATED_WORKER = process.env.PYRIC_REFUSAL_ISOLATED === '1';

interface AnyRecord {
  [key: string]: ((...args: unknown[]) => AnyRecord) & AnyRecord;
}

const requireHere = createRequire(import.meta.url);
const authEntry = requireHere.resolve('firebase-admin/auth');
const baseAuthMod = createRequire(authEntry)('./base-auth') as { BaseAuth: { prototype: object } };
const appCheckMod = createRequire(requireHere.resolve('firebase-admin/app-check'))('./app-check');
const messagingMod = createRequire(requireHere.resolve('firebase-admin/messaging'))('./messaging');
const dbSdk = createRequire(requireHere.resolve('firebase-admin/database'))('@firebase/database-compat/standalone');
const fsRequire = createRequire(requireHere.resolve('firebase-admin/firestore'));
const fsEntry = fsRequire.resolve('@google-cloud/firestore');
const fsSdk = fsRequire(fsEntry) as {
  v1: {
    FirestoreClient: new (opts?: object) => AnyRecord;
    FirestoreAdminClient: new (opts?: object) => AnyRecord;
  };
  v1beta1: {
    FirestoreClient: new (opts?: object) => AnyRecord;
  };
};
const stRequire = createRequire(requireHere.resolve('firebase-admin/storage'));
const stEntry = stRequire.resolve('@google-cloud/storage');
const stSdk = stRequire(stEntry) as Record<string, unknown>;

const adminApp = requireHere('firebase-admin/app') as {
  initializeApp(options: object, name: string): { delete(): Promise<void> };
};
const { getAuth } = requireHere('firebase-admin/auth') as { getAuth(app: object): AnyRecord };
const { getFirestore, v1: adminFsV1 } = requireHere('firebase-admin/firestore') as {
  getFirestore(app: object, databaseId?: string): AnyRecord;
  v1: {
    FirestoreClient: new (opts?: object) => AnyRecord;
    FirestoreAdminClient: new (opts?: object) => AnyRecord;
  };
};
const { getStorage, getDownloadURL } = requireHere('firebase-admin/storage') as {
  getStorage(app: object): AnyRecord;
  getDownloadURL(file: unknown): Promise<string>;
};
const { getDatabase } = requireHere('firebase-admin/database') as { getDatabase(app: object): AnyRecord };

function rejectedCode(thunk: () => unknown): Promise<string> {
  try {
    const result = thunk();
    return Promise.resolve(result).then(
      () => 'RESOLVED',
      (err: unknown) => String((err as { code?: unknown })?.code ?? (err as Error)?.message),
    );
  } catch (err) {
    return Promise.resolve(String((err as { code?: unknown })?.code ?? (err as Error)?.message));
  }
}

function streamOutcome(stream: Readable): Promise<{ status: 'ok'; items: unknown[] } | { status: 'error'; code: string }> {
  return new Promise((resolve) => {
    const items: unknown[] = [];
    stream.on('data', (chunk: unknown) => items.push(chunk));
    stream.once('error', (err: unknown) => {
      resolve({ status: 'error', code: String((err as { code?: unknown })?.code ?? err) });
    });
    stream.once('end', () => resolve({ status: 'ok', items }));
  });
}

async function asyncIterCode(iterable: AsyncIterable<unknown>): Promise<string> {
  try {
    for await (const _ of iterable) {
      // Unreachable on refusal.
    }
    return 'RESOLVED';
  } catch (err) {
    return String((err as { code?: unknown })?.code ?? err);
  }
}

describe.skipIf(IS_ISOLATED_WORKER)('AdminProjectGate behavioral refusal suite (isolated)', () => {
  it('enforces cross-project, named-DB, GAPIC, Storage option/HmacKey/userProject refusals and host observation', () => {
    const child = spawnSync(process.execPath, ['test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, PYRIC_REFUSAL_ISOLATED: '1' },
      encoding: 'utf8',
    });
    if (child.status !== 0) {
      throw new Error(`Isolated refusal suite failed (exit ${String(child.status)}):\n${child.stdout}\n${child.stderr}`);
    }
    expect(child.status).toBe(0);
  }, 30_000);
});

describe.skipIf(!IS_ISOLATED_WORKER)('AdminProjectGate behavioral refusal suite', () => {
  const records: LiveCallRecord[] = [];
  const observer: LiveObserver = Object.assign(
    (record: LiveCallRecord) => {
      records.push(record);
    },
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  let httpServer: HttpServer;
  let grpcHole: NetServer;
  let httpRequests: string[] = [];
  let grpcConnections = 0;
  let grpcPort = 0;
  let hostApp: { delete(): Promise<void> };
  let otherApp: { delete(): Promise<void> };
  let adcOtherApp: { delete(): Promise<void> };
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST',
      'FIREBASE_DATABASE_EMULATOR_HOST',
      'GOOGLE_CLOUD_PROJECT',
    ]) {
      prevEnv[key] = process.env[key];
    }

    httpServer = createServer((req, res) => {
      const url = req.url ?? '/';
      httpRequests.push(`${req.method ?? 'GET'} ${url}`);
      res.setHeader('content-type', 'application/json');
      if (url.includes('/tenants')) {
        res.end(JSON.stringify({ tenants: [] }));
        return;
      }
      if (url.includes('/config')) {
        res.end(JSON.stringify({ name: `projects/${HOST_PROJECT}/config` }));
        return;
      }
      if (url.includes('/acl')) {
        res.end(JSON.stringify({ items: [{ entity: 'project-owners-1', role: 'OWNER' }] }));
        return;
      }
      if (url.includes('/b?') || url.endsWith('/b')) {
        res.end(JSON.stringify({ items: [{ id: HOST_BUCKET, name: HOST_BUCKET }] }));
        return;
      }
      if (url.includes('/o?') || url.endsWith('/o')) {
        res.end(JSON.stringify({ items: [{ name: 'docs/readme.txt', bucket: HOST_BUCKET }] }));
        return;
      }
      if (url.includes('/v0/b/')) {
        res.end(JSON.stringify({ downloadTokens: 'tok-host-1' }));
        return;
      }
      res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = (httpServer.address() as { port: number }).port;

    grpcHole = createNetServer((socket) => {
      grpcConnections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => grpcHole.listen(0, '127.0.0.1', resolve));
    grpcPort = (grpcHole.address() as { port: number }).port;

    process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${httpPort}`;
    process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${httpPort}`;
    process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${grpcPort}`;
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = `127.0.0.1:${grpcPort}`;
    process.env.GOOGLE_CLOUD_PROJECT = HOST_PROJECT;

    const gate = adminProjectGate(HOST_PROJECT, () => undefined, {});
    observeAdminAuth(baseAuthMod, { observer, gate, hostProjectId: HOST_PROJECT }, authEntry);
    observeAdminAppCheck(appCheckMod, { gate });
    observeAdminMessaging(messagingMod, { observer, gate });
    observeAdminDatabase(dbSdk, { observer, gate, hostProjectId: HOST_PROJECT });
    observeAdminFirestore(fsSdk, fsEntry, { observer, gate });
    observeAdminStorage(stSdk, stEntry, { observer, gate });

    hostApp = adminApp.initializeApp(
      {
        projectId: HOST_PROJECT,
        storageBucket: HOST_BUCKET,
        databaseURL: `https://${HOST_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'refusal-host',
    );
    otherApp = adminApp.initializeApp(
      {
        projectId: OTHER_PROJECT,
        storageBucket: OTHER_BUCKET,
        databaseURL: `https://${OTHER_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'refusal-other',
    );
    adcOtherApp = adminApp.initializeApp(
      {
        credential: {
          getAccessToken: async () => ({ access_token: 'stub', expires_in: 3600 }),
          getProjectId: async () => OTHER_PROJECT,
        },
        databaseURL: `https://${HOST_PROJECT}-default-rtdb.firebaseio.com`,
      },
      'refusal-adc-other',
    );
  });

  afterAll(async () => {
    const hostFs = getFirestore(hostApp);
    const otherFs = getFirestore(otherApp);
    await hostFs.terminate!();
    await otherFs.terminate!();
    await Promise.all([hostApp?.delete(), otherApp?.delete(), adcOtherApp?.delete()]);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => grpcHole.close(() => resolve()));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses cross-project, named-database, GAPIC v1/v1beta1, HmacKey, userProject, and cross-bucket calls with zero network traffic', async () => {
    httpRequests = [];
    grpcConnections = 0;
    const beforeRecords = records.length;

    // 1. Auth sub-managers & TenantAwareAuth
    const otherAuth = getAuth(otherApp);
    const otherTm = otherAuth.tenantManager!();
    const otherTenantAuth = otherTm.authForTenant!('tenant-alpha');
    const otherPcm = otherAuth.projectConfigManager!();

    expect(await rejectedCode(() => otherTm.listTenants!())).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => otherTm.getTenant!('tenant-alpha'))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => otherTenantAuth.verifyIdToken!('invalid-jwt'))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => otherTenantAuth.createSessionCookie!('', { expiresIn: 1000 }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => otherTenantAuth.verifySessionCookie!(''))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => otherPcm.getProjectConfig!())).toBe('PYRIC_LIVE_REFUSED');

    // 2. High-level Firestore (cross-project & named DB)
    const otherFs = getFirestore(otherApp);
    const namedFs = getFirestore(hostApp, 'analytics-db');
    for (const db of [otherFs, namedFs]) {
      const col = db.collection!('items');
      const vec = col.findNearest!('emb', [0.1, 0.2], { limit: 2, distanceMeasure: 'COSINE' });
      const agg = col.count!();
      const group = db.collectionGroup!('items');
      expect(await rejectedCode(() => vec.get!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => vec.explain!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => col.explain!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => agg.explain!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await streamOutcome(col.stream!() as unknown as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
      expect(await streamOutcome(col.explainStream!() as unknown as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
      expect(await asyncIterCode(group.getPartitions!(4) as unknown as AsyncIterable<unknown>)).toBe('PYRIC_LIVE_REFUSED');
    }
    await namedFs.terminate!();

    // 3. Exported GAPIC v1.FirestoreAdminClient, v1.FirestoreClient, and v1beta1.FirestoreClient
    const gapicOptsOther = { projectId: OTHER_PROJECT, apiEndpoint: '127.0.0.1', port: grpcPort };
    const gapicOptsHost = { projectId: HOST_PROJECT, apiEndpoint: '127.0.0.1', port: grpcPort };
    const otherGapicAdmin = new adminFsV1.FirestoreAdminClient(gapicOptsOther);
    const hostGapicAdmin = new adminFsV1.FirestoreAdminClient(gapicOptsHost);
    const otherGapicClient = new adminFsV1.FirestoreClient(gapicOptsOther);
    const hostGapicClient = new adminFsV1.FirestoreClient(gapicOptsHost);
    const otherBetaClient = new fsSdk.v1beta1.FirestoreClient(gapicOptsOther);

    expect(
      await rejectedCode(() =>
        otherGapicAdmin.listFields!({ parent: `projects/${OTHER_PROJECT}/databases/(default)/collectionGroups/items` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await rejectedCode(() =>
        hostGapicAdmin.exportDocuments!({ name: `projects/${OTHER_PROJECT}/databases/(default)` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await rejectedCode(() =>
        hostGapicAdmin.listFields!({ parent: `projects/${HOST_PROJECT}/databases/secondary-db/collectionGroups/items` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await rejectedCode(() =>
        otherGapicClient.listCollectionIds!({ parent: `projects/${OTHER_PROJECT}/databases/(default)/documents` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await rejectedCode(() =>
        hostGapicClient.getDocument!({ name: `projects/${OTHER_PROJECT}/databases/(default)/documents/items/1` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await rejectedCode(() =>
        hostGapicClient.getDocument!({ name: `projects/${HOST_PROJECT}/databases/secondary-db/documents/items/1` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');
    expect(
      await streamOutcome(
        hostGapicClient.runQuery!({ parent: `projects/${OTHER_PROJECT}/databases/(default)/documents` }) as unknown as Readable,
      ),
    ).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
    expect(
      await asyncIterCode(
        hostGapicClient.listDocumentsAsync!({
          parent: `projects/${HOST_PROJECT}/databases/secondary-db/documents`,
          collectionId: 'items',
        }) as unknown as AsyncIterable<unknown>,
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    const duplex = hostGapicClient.write!() as unknown as Duplex;
    const duplexOutcome = new Promise<string>((resolve) => {
      duplex.once('error', (err: { code?: string }) => resolve(String(err.code)));
    });
    duplex.write({ database: `projects/${OTHER_PROJECT}/databases/(default)` });
    expect(await duplexOutcome).toBe('PYRIC_LIVE_REFUSED');

    expect(
      await rejectedCode(() =>
        otherBetaClient.listCollectionIds!({ parent: `projects/${OTHER_PROJECT}/databases/(default)/documents` }),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    await Promise.all([
      otherGapicAdmin.close!(),
      hostGapicAdmin.close!(),
      otherGapicClient.close!(),
      hostGapicClient.close!(),
      otherBetaClient.close!(),
    ]);

    // 4. Storage handles, HmacKey cross-project, setUserProject, and per-call option overrides
    const otherBucket = getStorage(otherApp).bucket!(OTHER_BUCKET);
    const otherSt = otherBucket.storage;
    const crossBucketOnHost = getStorage(hostApp).bucket!(OTHER_BUCKET);
    const hostBucket = getStorage(hostApp).bucket!(HOST_BUCKET);
    const hostSt = hostBucket.storage;

    expect(await rejectedCode(() => otherSt.getBuckets!())).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(otherSt.getBucketsStream!() as unknown as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
    expect(await rejectedCode(() => hostSt.createBucket!(OTHER_BUCKET))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => hostSt.createBucket!('custom-bucket', { userProject: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => hostSt.getBuckets!({ project: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(hostSt.getBucketsStream!({ project: OTHER_PROJECT }) as unknown as Readable)).toEqual({
      status: 'error',
      code: 'PYRIC_LIVE_REFUSED',
    });
    expect(await rejectedCode(() => hostSt.getHmacKeys!({ projectId: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(hostSt.getHmacKeysStream!({ projectId: OTHER_PROJECT }) as unknown as Readable)).toEqual({
      status: 'error',
      code: 'PYRIC_LIVE_REFUSED',
    });
    expect(await rejectedCode(() => hostSt.createHmacKey!('sa@example.iam.gserviceaccount.com', { projectId: OTHER_PROJECT }))).toBe(
      'PYRIC_LIVE_REFUSED',
    );
    expect(await rejectedCode(() => hostSt.getServiceAccount!({ userProject: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');

    const crossHmacOnHost = hostSt.hmacKey!('GOOG1E', { projectId: OTHER_PROJECT });
    expect(await rejectedCode(() => crossHmacOnHost.getMetadata!())).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => crossHmacOnHost.setMetadata!({ state: 'INACTIVE' }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => crossHmacOnHost.delete!())).toBe('PYRIC_LIVE_REFUSED');

    expect(await rejectedCode(() => hostBucket.setUserProject!(OTHER_PROJECT))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => hostBucket.file!('doc.txt').setUserProject!(OTHER_PROJECT))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => hostBucket.getFiles!({ userProject: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await streamOutcome(hostBucket.getFilesStream!({ userProject: OTHER_PROJECT }) as unknown as Readable)).toEqual({
      status: 'error',
      code: 'PYRIC_LIVE_REFUSED',
    });
    expect(await rejectedCode(() => hostBucket.iam!.getPolicy!({ userProject: OTHER_PROJECT }))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => hostBucket.file!('doc.txt').getMetadata!({ userProject: OTHER_PROJECT }))).toBe(
      'PYRIC_LIVE_REFUSED',
    );
    expect(await rejectedCode(() => getDownloadURL(otherBucket.file!('doc.txt')))).toBe('PYRIC_LIVE_REFUSED');
    expect(await rejectedCode(() => getDownloadURL(crossBucketOnHost.file!('doc.txt')))).toBe('PYRIC_LIVE_REFUSED');

    for (const bucket of [otherBucket, crossBucketOnHost]) {
      expect(await streamOutcome(bucket.getFilesStream!() as unknown as Readable)).toEqual({ status: 'error', code: 'PYRIC_LIVE_REFUSED' });
      expect(await rejectedCode(() => bucket.makePublic!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.acl!.get!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.acl!.owners!.addUser!('a@example.com'))).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.acl!.default!.get!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.iam!.getPolicy!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.file!('doc.txt').acl!.get!())).toBe('PYRIC_LIVE_REFUSED');
      expect(await rejectedCode(() => bucket.notification!('1').getMetadata!())).toBe('PYRIC_LIVE_REFUSED');
      const tm = new (stSdk.TransferManager as new (b: unknown) => AnyRecord)(bucket);
      expect(await rejectedCode(() => tm.downloadManyFiles!(['doc.txt']))).toBe('PYRIC_LIVE_REFUSED');
    }

    // 5. Database ADC OnDisconnect refusal
    const adcRef = getDatabase(adcOtherApp).ref!('items/1');
    let callbackCode: unknown;
    const odCode = await rejectedCode(() =>
      adcRef.onDisconnect!().set!(1, (err: { code?: unknown } | null) => {
        callbackCode = err?.code;
      }),
    );
    expect(odCode).toBe('PYRIC_LIVE_REFUSED');
    expect(callbackCode).toBe('PYRIC_LIVE_REFUSED');

    expect(httpRequests).toEqual([]);
    expect(grpcConnections).toBe(0);
    expect(records.slice(beforeRecords)).toEqual([]);
  });

  it('allows and observes host-project calls across TenantManager, ProjectConfigManager, Storage streams, Acl, and getDownloadURL', async () => {
    const beforeRecords = records.length;
    const hostAuth = getAuth(hostApp);
    const tenants = (await hostAuth.tenantManager!().listTenants!()) as unknown as { tenants: unknown[] };
    expect(tenants.tenants).toEqual([]);
    expect(await hostAuth.projectConfigManager!().getProjectConfig!()).toBeDefined();

    const hostBucket = getStorage(hostApp).bucket!(HOST_BUCKET);
    const hostSt = hostBucket.storage;
    const [buckets] = (await hostSt.getBuckets!()) as unknown as [unknown[]];
    expect(buckets).toHaveLength(1);
    const [aclEntries] = (await hostBucket.acl!.get!()) as unknown as [unknown[]];
    expect(aclEntries).toHaveLength(1);
    const downloadUrl = await getDownloadURL(hostBucket.file!('docs/readme.txt'));
    expect(downloadUrl).toContain('tok-host-1');

    expect((await streamOutcome(hostSt.getBucketsStream!() as unknown as Readable)).status).toBe('ok');
    expect((await streamOutcome(hostBucket.getFilesStream!() as unknown as Readable)).status).toBe('ok');

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(records.slice(beforeRecords).map((r) => r.name)).toEqual([
      'TenantManager.listTenants',
      'ProjectConfigManager.getProjectConfig',
      'Storage.getBuckets',
      'Storage.getBucketsStream',
      'Bucket.getFilesStream',
    ]);
  });
});
