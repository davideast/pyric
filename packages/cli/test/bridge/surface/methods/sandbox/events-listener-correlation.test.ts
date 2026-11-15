/**
 * Regression guards for `sandbox.events` listener correlation bounds and
 * deep immutability of opt-in `detail: true` payloads.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDatabase,
  limitToFirst,
  onValue,
  query as rtdbQuery,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { doc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import {
  initializeSandbox,
  type LocalSandbox,
  type OperationRecord,
  type RequestEvent,
  type SandboxEvent,
} from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { emitSandboxEvent } from 'pyric/sandbox/internal';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import {
  getAdminStorageSandbox,
  replaceStorageRules,
  storageDeniedWrites,
} from 'pyric/storage/internal';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

const OWNER_ONE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && request.auth.uid == 'owner-1';
      allow write: if request.auth != null && request.auth.uid == 'owner-1';
    }
  }
}`;

const ORPHAN_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && request.auth.uid == 'orphan-rule';
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

type DetailedRecord = OperationRecord & {
  request?: unknown;
  resourceBefore?: unknown;
  resourceAfter?: unknown;
};

const sdkSurface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;
let storageSeq = 0;

function storageDb(label: string): string {
  storageSeq += 1;
  return `events-correlation-${label}-${storageSeq}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function isDetailedRecord(value: unknown): value is DetailedRecord {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.service === 'string' &&
    typeof value.method === 'string' &&
    isObjectRecord(value.rules)
  );
}

function parseEventsPage(result: OperationResult): {
  events: DetailedRecord[];
  nextCursor: string | null;
} {
  expect(result.ok).toBe(true);
  if (!isObjectRecord(result.data) || !Array.isArray(result.data.events)) {
    throw new Error('Expected events page data');
  }
  const events: DetailedRecord[] = [];
  for (const item of result.data.events) {
    if (!isDetailedRecord(item)) {
      throw new Error('Unexpected record shape in events page');
    }
    events.push(item);
  }
  const cursor = result.data.nextCursor;
  if (cursor !== null && typeof cursor !== 'string') {
    throw new Error('Expected string or null nextCursor');
  }
  return { events, nextCursor: cursor };
}

async function runEvents(args: Record<string, unknown>): Promise<{
  events: DetailedRecord[];
  nextCursor: string | null;
}> {
  const tool = requireDefined(
    sdkSurface.tools.find((candidate) => candidate.name === 'sandbox'),
    'sandbox tool',
  );
  return parseEventsPage(await tool.execute({ method: 'events', args }, ctx));
}

function awaitDeniedListener(subscribe: (onError: () => void) => () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = subscribe(() => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => {
        unsubscribe();
        resolve();
      });
    });
  });
}

function nonPermissionListenerErrored(fields: {
  id: string;
  at: number;
  listenerId: string;
  path: string;
  uid: string;
  code: string;
  message: string;
}): SandboxEvent {
  return JSON.parse(
    JSON.stringify({
      kind: 'listener_errored',
      id: fields.id,
      at: fields.at,
      listenerId: fields.listenerId,
      target: { kind: 'doc', path: fields.path },
      auth: { uid: fields.uid },
      error: { code: fields.code, message: fields.message },
    }),
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-events-correlation-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox.events detail immutability and listener correlation bounds', () => {
  it('deep-clones and freezes detail payloads so callers cannot alias live history or Storage records', async () => {
    setRules(sandbox, OWNER_ONE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'owner-1', nested: { secret: 'before' } } });
    const fsDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));
    await setDoc(doc(fsDb, 'items/item-1'), {
      owner: 'owner-1',
      nested: { secret: 'candidate' },
    }).catch(() => undefined);

    const adminStorage = getAdminStorageSandbox(sandbox, { dbName: storageDb('immutability') });
    await replaceStorageRules(sandbox, STORAGE_RULES);
    await uploadBytes(
      storageRef(adminStorage, 'files/owner-1/doc.txt'),
      new Uint8Array([1, 2, 3]),
      { contentType: 'text/plain', customMetadata: { tag: 'original' } },
    );
    const clientStorage = getStorageSandbox(sandbox.withAuth({ uid: 'user-2' }));
    await uploadBytes(
      storageRef(clientStorage, 'files/owner-1/doc.txt'),
      new Uint8Array([4, 5, 6, 7]),
      { contentType: 'text/plain', customMetadata: { tag: 'tampered' } },
    ).catch(() => undefined);

    const { events } = await runEvents({ kind: 'denials', limit: 50, detail: true });
    const fsSet = requireDefined(
      events.find((r) => r.service === 'firestore' && r.method === 'set'),
      'firestore detailed denial',
    );
    const rawFsSet = requireDefined(
      sandbox.history().find(
        (e): e is RequestEvent & SandboxEvent => e.kind === 'request' && e.id === fsSet.id,
      ),
      'raw firestore set event',
    );

    expect(Object.isFrozen(fsSet)).toBe(true);
    expect(Object.isFrozen(fsSet.request)).toBe(true);
    expect(Object.isFrozen(fsSet.resourceBefore)).toBe(true);
    expect(Object.isFrozen(fsSet.resourceAfter)).toBe(true);
    expect(fsSet.request).not.toBe(rawFsSet.request);
    expect(fsSet.resourceBefore).not.toBe(rawFsSet.resourceBefore);
    expect(fsSet.resourceAfter).not.toBe(rawFsSet.resourceAfter);

    const fsReqObj = fsSet.request;
    if (!isObjectRecord(fsReqObj) || !isObjectRecord(fsReqObj.resourceData)) {
      throw new Error('Expected nested resourceData on Firestore detail request');
    }
    expect(Object.isFrozen(fsReqObj.resourceData)).toBe(true);
    expect(() => {
      fsReqObj.resourceData = { tampered: true };
    }).toThrow(TypeError);

    const stCreate = requireDefined(
      events.find((r) => r.service === 'storage' && r.method === 'create'),
      'storage detailed denial',
    );
    const storedEntry = requireDefined(
      storageDeniedWrites(sandbox).get(stCreate.id),
      'storage denied write entry',
    );
    expect(Object.isFrozen(stCreate.request)).toBe(true);
    expect(Object.isFrozen(stCreate.resourceBefore)).toBe(true);
    if (!isObjectRecord(stCreate.request) || !isObjectRecord(stCreate.resourceBefore)) {
      throw new Error('Expected object request and resourceBefore on Storage detail record');
    }
    expect(stCreate.request.resourceData).not.toBe(storedEntry.requestResource);
    expect(Object.isFrozen(stCreate.request.resourceData)).toBe(true);
    expect(stCreate.resourceBefore.data).not.toBe(storedEntry.resource);
    expect(Object.isFrozen(stCreate.resourceBefore.data)).toBe(true);
  });

  it('does not attach an earlier-page denied RTDB listener request onto a later callback error or other instance', async () => {
    const db = getDatabase(sandbox.withAuth({ uid: 'user-2' }));
    rtdbSandbox.setRules(db, {
      rules: {
        items: {
          $id: {
            '.read': 'auth.uid === $id',
          },
        },
      },
    });
    const queried = rtdbQuery(rtdbRef(db, 'items/owner-1'), limitToFirst(5));
    await awaitDeniedListener((onError) => onValue(queried, () => {}, onError));

    const firstPageAll = await runEvents({ kind: 'all', limit: 50, detail: true });
    const lastId = requireDefined(sandbox.history().at(-1)?.id, 'last event id on page 1');
    expect(firstPageAll.events.some((e) => e.service === 'rtdb' && e.request !== undefined)).toBe(
      true,
    );

    // Emit a later callback runtime error on the same path, and a denied listener on a different instance.
    emitSandboxEvent(sandbox, {
      kind: 'listener',
      id: 'rtdb-callback-err',
      at: Date.now() + 1,
      service: 'rtdb',
      phase: 'errored',
      listenerId: 'l-cb-err',
      target: { kind: 'value', path: '/items/owner-1' },
      auth: { uid: 'user-2' },
      result: 'error',
      error: { message: 'callback threw' },
    });
    emitSandboxEvent(sandbox, {
      kind: 'listener',
      id: 'rtdb-other-instance-deny',
      at: Date.now() + 2,
      service: 'rtdb',
      instance: 'other-instance',
      phase: 'errored',
      listenerId: 'l-other-inst',
      target: { kind: 'value', path: '/items/owner-1' },
      auth: { uid: 'user-2' },
      result: 'deny',
      reasons: ['Denied on other-instance'],
      rules: { engine: 'rtdb', matchedPath: '/items/$id', matchedRule: 'false' },
    });

    const page2Listeners = await runEvents({
      kind: 'listeners',
      since: lastId,
      limit: 50,
      detail: true,
    });
    const cbErrListener = requireDefined(
      page2Listeners.events.find((e) => e.id === 'rtdb-callback-err'),
      'callback error in listeners page',
    );
    expect(cbErrListener.denial).toBeUndefined();
    expect('request' in cbErrListener).toBe(false);

    const otherInstListener = requireDefined(
      page2Listeners.events.find((e) => e.id === 'rtdb-other-instance-deny'),
      'other-instance denial in listeners page',
    );
    expect('request' in otherInstListener).toBe(false);

    const page2All = await runEvents({ kind: 'all', since: lastId, limit: 50, detail: true });
    const cbErrAll = requireDefined(
      page2All.events.find((e) => e.id === 'rtdb-callback-err'),
      'callback error in all page',
    );
    expect('request' in cbErrAll).toBe(false);
    const otherInstAll = requireDefined(
      page2All.events.find((e) => e.id === 'rtdb-other-instance-deny'),
      'other-instance denial in all page',
    );
    expect('request' in otherInstAll).toBe(false);
  });

  it('does not misattribute prior or setRules-orphan Firestore denials across since, unavailable errors, or auth claims', async () => {
    setRules(sandbox, OWNER_ONE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'owner-1' } });
    const fsDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));

    // Keep listener 1 attached so setRules() triggers an orphan denied RequestEvent.
    const stopErroredListener = await new Promise<() => void>((resolve) => {
      let settled = false;
      const unsubscribe = onSnapshot(
        doc(fsDb, 'items/item-1'),
        () => {},
        () => {
          if (settled) return;
          settled = true;
          resolve(unsubscribe);
        },
      );
    });
    try {
      const cursorAfterFirst = requireDefined(
        sandbox.history().at(-1)?.id,
        'cursor after first denied listener',
      );

      // (a) Across `since`: a non-denial unavailable error must not inherit page 1's denial.
      emitSandboxEvent(
        sandbox,
        nonPermissionListenerErrored({
          id: 'fs-unavail-page2',
          at: Date.now() + 1,
          listenerId: 'l-unavail-2',
          path: 'items/item-1',
          uid: 'user-2',
          code: 'unavailable',
          message: 'stream disconnected',
        }),
      );
      const page2 = await runEvents({
        kind: 'listeners',
        since: cursorAfterFirst,
        limit: 50,
        detail: true,
      });
      const unavail = requireDefined(
        page2.events.find((e) => e.id === 'fs-unavail-page2'),
        'unavailable listener on page 2',
      );
      expect(unavail.result).toBe('error');
      expect(unavail.rules).toEqual({ kind: 'not-evaluated', reason: 'runtime-error' });
      expect(unavail.denial).toBeUndefined();
      expect('resourceBefore' in unavail).toBe(false);

      // (b) Without `since`: setRules() emits an orphan denied RequestEvent with no listener_errored.
      setRules(sandbox, ORPHAN_RULE);
      emitSandboxEvent(
        sandbox,
        nonPermissionListenerErrored({
          id: 'fs-unavail-after-orphan',
          at: Date.now() + 2,
          listenerId: 'l-unavail-3',
          path: 'items/item-1',
          uid: 'user-2',
          code: 'unavailable',
          message: 'transport reset',
        }),
      );
      // (c) A newly attached listener whose attach follows the orphan must not cross its own attach.
      emitSandboxEvent(sandbox, {
        kind: 'listener_attach',
        id: 'fs-attach-new',
        at: Date.now() + 3,
        listenerId: 'l-new',
        target: { kind: 'doc', path: 'items/item-1' },
        auth: { uid: 'user-2' },
      });
      emitSandboxEvent(sandbox, {
        kind: 'listener_errored',
        id: 'fs-denied-no-req',
        at: Date.now() + 4,
        listenerId: 'l-new',
        target: { kind: 'doc', path: 'items/item-1' },
        auth: { uid: 'user-2' },
        error: { code: 'permission-denied', message: 'direct stream deny' },
      });
      // (d) Same uid with different token claims must not pair with the orphan request.
      emitSandboxEvent(sandbox, {
        kind: 'listener_errored',
        id: 'fs-denied-other-claims',
        at: Date.now() + 5,
        listenerId: 'l-claims',
        target: { kind: 'doc', path: 'items/item-1' },
        auth: { uid: 'user-2', token: { tenant: 'tenant-b' } },
        error: { code: 'permission-denied', message: 'tenant-b deny' },
      });

      const allListeners = await runEvents({ kind: 'listeners', limit: 50, detail: true });
      const afterOrphan = requireDefined(
        allListeners.events.find((e) => e.id === 'fs-unavail-after-orphan'),
        'unavailable after orphan',
      );
      expect(afterOrphan.denial).toBeUndefined();

      const noReqNew = requireDefined(
        allListeners.events.find((e) => e.id === 'fs-denied-no-req'),
        'new listener after attach',
      );
      expect(noReqNew.denial).toEqual({ reasons: ['direct stream deny'] });
      expect(noReqNew.denial?.rule).toBeUndefined();

      const otherClaims = requireDefined(
        allListeners.events.find((e) => e.id === 'fs-denied-other-claims'),
        'different token claims listener',
      );
      expect(otherClaims.denial).toEqual({ reasons: ['tenant-b deny'] });
      expect(otherClaims.denial?.rule).toBeUndefined();
    } finally {
      stopErroredListener();
    }
  });
});
