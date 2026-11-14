/**
 * A live page answers the reads its host routes to it (`tab-reads.ts`) on
 * the app's own Firestore instance, through the live row, so each read is a
 * live record like the app's own. The real `firebase/firestore` runs with
 * its network disabled: a write the app made is in its local cache, and
 * `getDoc` answers from it.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/tab-reads.test.ts'`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { liveModuleFor, type LiveCallRecord, type LiveModuleSite } from '../src/index.js';
import { noteReadModule } from '../src/tab-reads.js';

interface ReadHub {
  reader?: {
    tools(): string[];
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }> | undefined;
  };
}

const hub = (): ReadHub | undefined => (globalThis as Record<symbol, ReadHub | undefined>)[Symbol.for('pyric.live.reads')];

const records: LiveCallRecord[] = [];
const site: LiveModuleSite = { observer: (record) => { records.push(record); }, sdkVersion: realApp.SDK_VERSION, client: 'page' };
const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
const app = realApp.initializeApp({ apiKey: 'demo-api-key', projectId: 'demo-tab-reads', appId: '1:1:web:tab-reads' }, 'tab-reads');

afterAll(async () => {
  await realApp.deleteApp(app);
});

describe('a live page answers its host reads', () => {
  test('a routed firestore_get_document runs getDoc on the app instance and returns the document', async () => {
    const db = firestore.getFirestore(app);
    await realFirestore.disableNetwork(db);
    void firestore.setDoc(firestore.doc(db, 'rooms/a'), { name: 'Lobby', seats: 4 }).catch(() => undefined);
    expect(hub()?.reader?.tools()).toEqual(expect.arrayContaining(['firestore_get_document', 'firestore.getDoc', 'firestore_list_documents']));
    records.length = 0;
    const answer = await hub()?.reader?.call('firestore_get_document', { path: 'rooms/a' });
    expect(answer).toEqual({ ok: true, summary: 'Got rooms/a', data: { exists: true, data: { name: 'Lobby', seats: 4 } } });
    const read = records.find((record) => record.name === 'getDoc' && record.outcome === 'resolved');
    expect(read).toMatchObject({ module: 'firebase/firestore', path: 'rooms/a', projectId: 'demo-tab-reads' });
  });

  test('a routed collection read lists the documents in the sandbox shape', async () => {
    const answer = await hub()?.reader?.call('firestore.getDocs', { path: 'rooms' });
    expect(answer?.ok).toBe(true);
    expect(answer?.data).toEqual({ docs: [{ id: 'a', data: { name: 'Lobby', seats: 4 } }] });
  });

  test('preserves the [DEFAULT] app and primary default-database Firestore handle when secondary FirebaseApps open afterward', async () => {
    const hits: { projectId?: string; dbId: string }[] = [];
    const mockFirestore: Record<string, unknown> = {
      getFirestore(appArg?: { name?: string; options?: { projectId?: string } }, databaseId?: string) {
        return { app: appArg, _databaseId: databaseId ?? '(default)' };
      },
      doc(db: unknown, path: string) {
        return { firestore: db, path };
      },
      async getDoc(ref: { firestore: { app?: { options?: { projectId?: string } }; _databaseId: string } }) {
        hits.push({ projectId: ref.firestore.app?.options?.projectId, dbId: ref.firestore._databaseId });
        return { exists: () => true, data: () => ({ ok: true }) };
      },
    };
    noteReadModule('live-firestore', mockFirestore);
    const getFs = mockFirestore.getFirestore as (app?: unknown, dbId?: string) => unknown;

    // 1. Unnamed mock handles (mainApp opened first, secondaryApp opened second).
    const mainApp = { options: { projectId: 'org-alpha' } };
    const secondaryApp = { options: { projectId: 'org-beta' } };
    getFs(mainApp);
    getFs(secondaryApp);
    await hub()?.reader?.call('firestore.getDoc', { path: 'items/item-1' });
    expect(hits.at(-1)).toEqual({ projectId: 'org-alpha', dbId: '(default)' });

    // 2. Named secondary FirebaseApp opened BEFORE [DEFAULT] FirebaseApp: [DEFAULT] wins once opened,
    //    and opening another secondary app or named database later never clobbers [DEFAULT].
    noteReadModule('live-firestore', mockFirestore);
    const earlySecondary = { name: 'analytics', options: { projectId: 'org-beta' } };
    const defaultApp = { name: '[DEFAULT]', options: { projectId: 'org-alpha' } };
    const lateSecondary = { name: 'tenant-other', options: { projectId: 'org-gamma' } };
    getFs(earlySecondary);
    getFs(defaultApp);
    getFs(lateSecondary);
    getFs(defaultApp, 'reporting-db');
    await hub()?.reader?.call('firestore_get_document', { path: 'items/item-2' });
    expect(hits.at(-1)).toEqual({ projectId: 'org-alpha', dbId: '(default)' });

    // Restore the real wrapped module for any subsequent suite assertions.
    noteReadModule('live-firestore', firestore as unknown as Record<string, unknown>);
    firestore.getFirestore(app);
  });
});

describe('a live page answers Storage reads and crawls to a depth', () => {
  test('a routed storage.listAll and storage.getMetadata run on the app Storage instance in the sandbox shape', async () => {
    const bucket = { name: 'bucket' };
    const reference = (path: string) => ({ fullPath: path });
    const storageModule: Record<string, unknown> = {
      getStorage: () => bucket,
      ref: (_storage: unknown, path: string) => reference(path),
      listAll: async (folder: { fullPath: string }) => ({ items: [reference(`${folder.fullPath}/a.txt`)], prefixes: [reference(`${folder.fullPath}/nested`)] }),
      getMetadata: async (object: { fullPath: string }) => ({ fullPath: object.fullPath, size: 6, contentType: 'text/plain', ref: object }),
    };
    noteReadModule('live-storage', storageModule);
    (storageModule.getStorage as () => unknown)();
    expect(hub()?.reader?.tools()).toEqual(expect.arrayContaining(['storage.listAll', 'storage.getMetadata']));
    expect(await hub()?.reader?.call('storage.listAll', { prefix: 'uploads' })).toEqual({
      ok: true, summary: '1 objects under uploads', data: { items: ['uploads/a.txt'], prefixes: ['uploads/nested'] },
    });
    expect(await hub()?.reader?.call('storage.getMetadata', { path: 'uploads/a.txt' })).toEqual({
      ok: true, summary: 'Read metadata for uploads/a.txt', data: { metadata: { fullPath: 'uploads/a.txt', size: 6, contentType: 'text/plain' } },
    });
  });

  test('rtdb_crawl_structure descends maxDepth object levels, as the sandbox crawl does', async () => {
    const tree = { rooms: { a: { name: 'A', members: { u1: true } } } };
    const databaseModule: Record<string, unknown> = {
      getDatabase: () => ({ name: 'db' }),
      ref: (_db: unknown, path: string) => path,
      get: async () => ({ val: () => tree }),
    };
    noteReadModule('live-database', databaseModule);
    (databaseModule.getDatabase as () => unknown)();
    const deep = await hub()?.reader?.call('rtdb_crawl_structure', {});
    expect(deep?.summary).toBe('Crawled 3 object paths from /');
    const shallow = await hub()?.reader?.call('rtdb_crawl_structure', { maxDepth: 1 });
    expect(shallow).toEqual({
      ok: true,
      summary: 'Crawled 1 object paths from /',
      data: {
        path: '/', childCount: 1, truncated: false, schema: {},
        children: [{ path: '/rooms', childCount: 1, truncated: true, children: [], schema: {} }],
      },
    });
  });

  test('routes instance and bucket selectors across multiple handles, refuses unopened selectors, and returns Storage metadata faithfully without ref', async () => {
    const dbPrimary = { app: { name: '[DEFAULT]', options: { projectId: 'proj-1' } }, _repoInternal: { repoInfo_: { namespace: 'proj-1-default-rtdb' } } };
    const dbSecondary = { app: { name: '[DEFAULT]', options: { projectId: 'proj-1' } }, _repoInternal: { repoInfo_: { namespace: 'proj-1-secondary' } } };
    const dbOtherApp = { app: { name: 'other-app', options: { projectId: 'proj-2' } }, _repoInternal: { repoInfo_: { namespace: 'proj-2-default-rtdb' } } };
    const databaseModule: Record<string, unknown> = {
      getDatabase: (appArg?: { name?: string }, url?: string) => {
        if (url) return dbSecondary;
        if (appArg?.name === 'other-app') return dbOtherApp;
        return dbPrimary;
      },
      ref: (db: unknown, path: string) => ({ db, path }),
      get: async (r: { db: unknown; path: string }) => {
        let source = 'primary';
        if (r.db === dbSecondary) source = 'secondary';
        else if (r.db === dbOtherApp) source = 'other-app';
        return { exists: () => true, val: () => ({ source }) };
      },
    };
    noteReadModule('live-database', databaseModule);
    (databaseModule.getDatabase as (a?: unknown, u?: string) => unknown)({ name: '[DEFAULT]' });
    (databaseModule.getDatabase as (a?: unknown, u?: string) => unknown)({ name: '[DEFAULT]' }, 'https://proj-1-secondary.firebaseio.com');
    (databaseModule.getDatabase as (a?: unknown, u?: string) => unknown)({ name: 'other-app' });

    expect((await hub()?.reader?.call('database.get', { path: '/items' }))?.data).toEqual({
      exists: true,
      value: { source: 'primary' },
    });
    expect((await hub()?.reader?.call('database.get', { path: '/items', instance: 'default' }))?.data).toEqual({
      exists: true,
      value: { source: 'primary' },
    });
    expect((await hub()?.reader?.call('database.get', { path: '/items', instance: 'proj-1-secondary' }))?.data).toEqual({
      exists: true,
      value: { source: 'secondary' },
    });
    const unopenedDb = await hub()?.reader?.call('database.get', { path: '/items', instance: 'proj-1-missing' });
    expect(unopenedDb?.ok).toBe(false);
    expect((unopenedDb?.data as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const stDefault = { app: { options: { projectId: 'proj-1', storageBucket: 'proj-1.appspot.com' } }, _bucket: { bucket: 'proj-1.appspot.com' } };
    const stAssets = { app: { options: { projectId: 'proj-1', storageBucket: 'proj-1.appspot.com' } }, _bucket: { bucket: 'proj-1-assets' } };
    const storageModule: Record<string, unknown> = {
      getStorage: (_app?: unknown, url?: string) => (url ? stAssets : stDefault),
      ref: (st: unknown, path: string) => ({ st, fullPath: path }),
      listAll: async (folder: { st: unknown; fullPath: string }) => ({
        items: [{ fullPath: folder.st === stAssets ? 'assets/logo.png' : 'default/doc.txt' }],
        prefixes: [],
      }),
      getMetadata: async (obj: { st: unknown; fullPath: string }) => {
        if (obj.fullPath === 'fail/missing') {
          throw Object.assign(new Error('Object does not exist'), { code: 'storage/object-not-found' });
        }
        return {
          fullPath: obj.fullPath,
          bucket: obj.st === stAssets ? 'proj-1-assets' : 'proj-1.appspot.com',
          size: 12,
          contentType: 'text/plain',
          downloadTokens: 'token-123',
          customMetadata: {
            ownerEmail: 'ada@example.test',
            firebaseStorageDownloadTokens: 'token-123',
          },
          ref: obj,
        };
      },
    };
    noteReadModule('live-storage', storageModule);
    (storageModule.getStorage as (a?: unknown, u?: string) => unknown)(undefined);
    (storageModule.getStorage as (a?: unknown, u?: string) => unknown)(undefined, 'gs://proj-1-assets');

    expect((await hub()?.reader?.call('storage.listAll', { prefix: '' }))?.data).toEqual({
      items: ['default/doc.txt'],
      prefixes: [],
    });
    expect((await hub()?.reader?.call('storage.listAll', { prefix: '', bucket: 'gs://proj-1-assets' }))?.data).toEqual({
      items: ['assets/logo.png'],
      prefixes: [],
    });
    const unopenedBucket = await hub()?.reader?.call('storage.listAll', { prefix: '', bucket: 'proj-1-unopened' });
    expect(unopenedBucket?.ok).toBe(false);
    expect((unopenedBucket?.data as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    const metaRes = await hub()?.reader?.call('storage.getMetadata', { path: 'docs/d1.txt' });
    expect(metaRes?.ok).toBe(true);
    const meta = (metaRes?.data as { metadata: Record<string, unknown> }).metadata;
    expect(meta.ref).toBeUndefined();
    expect(meta.downloadTokens).toBe('token-123');
    expect(meta.customMetadata).toEqual({
      ownerEmail: 'ada@example.test',
      firebaseStorageDownloadTokens: 'token-123',
    });

    const errRes = await hub()?.reader?.call('storage.getMetadata', { path: 'fail/missing' });
    expect(errRes).toEqual({
      ok: false,
      summary: "storage.getMetadata failed in the app's tab: storage/object-not-found: Object does not exist",
      data: { code: 'storage/object-not-found' },
    });
  });
});
