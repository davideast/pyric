import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { observedCallEvent } from 'pyric/sandbox/internal';
import { getStorage, getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { subjectTarget } from '../features/traffic/verdict.js';
import { studioTrafficEvents } from './studio-events.js';

const SECOND_BUCKET = 'demo-live-storage-live-second';

const APP_BUCKET = 'demo-app.appspot.com';

const OPEN_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

/** The Storage events a sandboxed app emits uploading one object to its default bucket. */
async function uploadedEvents(path: string): Promise<SandboxEvent[]> {
  const sandbox = initializeSandbox({});
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  const unique = Math.random().toString(36).slice(2, 10);
  getStorageSandbox(sandbox, { dbName: `pyric-studio-events-${unique}`, rules: OPEN_STORAGE_RULES });
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: APP_BUCKET }, `studio-events-${unique}`);
  await uploadBytes(ref(getStorage(app), path), new Uint8Array([1]));
  return events.filter((event) => event.kind === 'operation' && event.service === 'storage');
}

function storageOperation(path: string, bucket: unknown, bucketName?: unknown): SandboxEvent {
  return {
    kind: 'operation',
    id: 's1',
    at: 1000,
    service: 'storage',
    method: 'getMetadata',
    path,
    auth: null,
    result: 'allow',
    origin: 'user',
    reasons: [],
    detail: bucketName === undefined ? { bucket } : { bucket, bucketName },
    rulesDisposition: { kind: 'evaluated', verdict: 'allow' },
    rules: { engine: 'storage' },
  } as unknown as SandboxEvent;
}

function trafficPath(event: SandboxEvent): string | undefined {
  return studioTrafficEvents([event])[0]?.path;
}

describe('a Storage row in Studio names its bucket', () => {
  test("reads an observed call's path as gs://<bucket>/<path>", () => {
    const event = observedCallEvent({
      service: 'storage',
      method: 'getMetadata',
      path: 'pyric-live-capture/replay/a.bin',
      bucket: SECOND_BUCKET,
      at: 1000,
      outcome: { status: 'ok' },
    });
    expect(trafficPath(event)).toBe(`gs://${SECOND_BUCKET}/pyric-live-capture/replay/a.bin`);
  });

  test("reads an observed call on the bucket's root as gs://<bucket>/", () => {
    const event = observedCallEvent({ service: 'storage', method: 'list', bucket: SECOND_BUCKET, at: 1000, outcome: { status: 'ok' } });
    expect(trafficPath(event)).toBe(`gs://${SECOND_BUCKET}/`);
  });

  test('reads a sandbox Storage operation the same way', () => {
    expect(trafficPath(storageOperation('avatars/alice.png', 'demo-app.appspot.com'))).toBe('gs://demo-app.appspot.com/avatars/alice.png');
    expect(trafficPath(storageOperation('', 'demo-app.appspot.com'))).toBe('gs://demo-app.appspot.com/');
    expect(trafficPath(storageOperation('/', 'demo-app.appspot.com'))).toBe('gs://demo-app.appspot.com/');
  });

  test('leaves the path alone when no string bucket is named', () => {
    expect(trafficPath(storageOperation('avatars/alice.png', undefined))).toBe('avatars/alice.png');
    expect(trafficPath(storageOperation('avatars/alice.png', 7))).toBe('avatars/alice.png');
    expect(trafficPath(storageOperation('avatars/alice.png', ''))).toBe('avatars/alice.png');
  });

  test("reads the app's bucket name over the sandbox's store key", () => {
    expect(trafficPath(storageOperation('avatars/alice.png', 'pyric-default', APP_BUCKET))).toBe(`gs://${APP_BUCKET}/avatars/alice.png`);
    expect(trafficPath(storageOperation('avatars/alice.png', 'pyric-default', ''))).toBe('gs://pyric-default/avatars/alice.png');
  });

  test("reads a sandboxed app's upload to its default bucket under the app's bucket name", async () => {
    const events = await uploadedEvents('avatars/alice.png');
    expect(events.length).toBeGreaterThan(0);
    // The store key is not the bucket's name; the row must not read gs://pyric-default/.
    for (const event of events) expect(event.kind === 'operation' && event.detail).toEqual({ bucket: 'pyric-default', bucketName: APP_BUCKET });
    expect(studioTrafficEvents(events).map((row) => row.path)).toEqual(events.map(() => `gs://${APP_BUCKET}/avatars/alice.png`));
  });
});

describe("a Storage row's gs:// path opens the pane", () => {
  function targetOf(event: SandboxEvent) {
    const row = studioTrafficEvents([event])[0]!;
    return subjectTarget(row);
  }

  test('at the object path, with the bucket prefix stripped', () => {
    expect(targetOf(storageOperation('avatars/alice.png', 'demo-app.appspot.com'))).toEqual({ tab: 'storage', rest: ['avatars', 'alice.png'] });
  });

  test('at the bucket root for gs://<bucket>/', () => {
    expect(targetOf(storageOperation('', 'demo-app.appspot.com'))).toEqual({ tab: 'storage' });
    const rootList = observedCallEvent({ service: 'storage', method: 'list', bucket: SECOND_BUCKET, at: 1000, outcome: { status: 'ok' } });
    expect(targetOf(rootList)).toEqual({ tab: 'storage' });
  });

  test("at a second bucket's listed prefix, in the pane's own bucket", () => {
    const list = observedCallEvent({ service: 'storage', method: 'list', path: 'pyric-live-capture/replay', bucket: SECOND_BUCKET, at: 1000, outcome: { status: 'ok' } });
    expect(targetOf(list)).toEqual({ tab: 'storage', rest: ['pyric-live-capture', 'replay'], query: { kind: 'prefix' } });
  });

  test('leaves a path without the prefix routed as before', () => {
    expect(subjectTarget({ service: 'storage', method: 'get', path: 'uploads/logo.png' })).toEqual({ tab: 'storage', rest: ['uploads', 'logo.png'] });
    expect(subjectTarget({ service: 'firestore', method: 'get', path: 'gs://not/a/doc' })).toEqual({ tab: 'firestore', rest: ['gs:', 'not', 'a', 'doc'] });
  });
});

describe('a Messaging row in Studio lists its requests', () => {
  test("reads an observed getToken's path as the requests it made, with no record to open", () => {
    const event = observedCallEvent({
      service: 'messaging',
      method: 'getToken',
      at: 1000,
      outcome: { status: 'error', code: 'permission_denied' },
      requests: [
        { api: 'installations', action: 'create', status: 200 },
        { api: 'registrations', action: 'create', status: 403 },
      ],
    });
    expect(trafficPath(event)).toBe('Installations create, 200; registrations create, 403');
    expect(subjectTarget(studioTrafficEvents([event])[0]!)).toBeNull();
  });

  test('lists a request with no status by its API and action', () => {
    const event = observedCallEvent({
      service: 'messaging',
      method: 'getToken',
      at: 1000,
      outcome: { status: 'ok' },
      requests: [{ api: 'installations', action: 'generateAuthToken' }, { api: 'registrations', action: 'update', status: 200 }],
    });
    expect(trafficPath(event)).toBe('Installations generate auth token; registrations update, 200');
  });

  test('keeps the service placeholder for a Messaging call with no requests', () => {
    const event = observedCallEvent({ service: 'messaging', method: 'deleteToken', at: 1000, outcome: { status: 'ok' } });
    expect(trafficPath(event)).toBe('(service)');
  });
});
