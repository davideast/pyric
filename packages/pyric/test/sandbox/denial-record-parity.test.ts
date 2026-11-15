/**
 * Denial diagnostics on canonical operation and listener records and on
 * `inspect()`.
 *
 * Plants real denials across every rules-evaluating service (Firestore,
 * Realtime Database, Storage) and every denial shape (write, read, listener),
 * plus expired Firestore rules evidence, and asserts parity with the raw
 * captured events.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  get as rtdbGet,
  getDatabase,
  onValue,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  set as rtdbSet,
} from 'pyric/database';
import {
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
} from 'pyric/firestore';
import {
  initializeSandbox,
  toListenerRecord,
  toOperationRecord,
  type RequestEvent,
  type SandboxEvent,
  type SandboxListenerEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { inspect, seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getBytes, getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
      allow write: if request.auth != null && request.auth.uid == request.resource.data.owner;
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

const RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': 'auth.uid === $id',
        '.write': 'auth.uid === $id',
      },
    },
  },
};

let storageSeq = 0;
function storageDb(label: string): string {
  storageSeq += 1;
  return `denial-record-parity-${label}-${storageSeq}`;
}

function awaitDeniedFirestoreListener(
  subscribe: (onError: () => void) => () => void,
): Promise<void> {
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

function awaitDeniedRtdbListener(
  subscribe: (onError: () => void) => () => void,
): Promise<void> {
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

describe('denial projection parity across rules-evaluating services', () => {
  it('projects Firestore write, read, and listener denials with reasons and matched rule', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1', title: 'draft' } });
    const db = getFirestore(sandbox.withAuth({ uid: 'user-2' }));

    await expect(getDoc(doc(db, 'items/item-1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      setDoc(doc(db, 'items/item-1'), { owner: 'user-1', title: 'tampered' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await awaitDeniedFirestoreListener((onError) =>
      onSnapshot(doc(db, 'items/item-1'), () => {}, onError),
    );
    await awaitDeniedFirestoreListener((onError) =>
      onSnapshot(collection(db, 'items'), () => {}, onError),
    );

    const history = sandbox.history();
    const deniedRequests = history.filter(
      (event): event is RequestEvent & SandboxEvent =>
        event.kind === 'request' && event.result === 'deny',
    );
    expect(deniedRequests.map((event) => `${event.origin}:${event.method}`)).toEqual([
      'user:get',
      'user:set',
      'listener:get',
      'listener:list',
    ]);

    for (const raw of deniedRequests) {
      const record = toOperationRecord(raw);
      expect(record).not.toBeNull();
      expect(record!.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record!.denial).toBeDefined();
      expect(record!.denial!.reasons).toEqual(raw.reasons);
      expect(record!.denial!.reasons.length).toBeGreaterThan(0);
      expect(Object.isFrozen(record!.denial)).toBe(true);
      expect(Object.isFrozen(record!.denial!.reasons)).toBe(true);
      if (raw.evaluatedRule !== undefined) {
        expect(record!.denial!.rule).toBeDefined();
        expect(record!.denial!.rule!.expression).toBe(raw.evaluatedRule.expression);
        expect(record!.denial!.rule!.citation).toBe(raw.evaluatedRule.citation);
        expect(record!.denial!.rule!.line).toBe(raw.evaluatedRule.line);
        expect(record!.denial!.rule!.path).toBe('/items/{id}');
        expect(Object.isFrozen(record!.denial!.rule)).toBe(true);
      }
    }

    const erroredListeners = history.filter((event) => event.kind === 'listener_errored');
    expect(erroredListeners).toHaveLength(2);
    for (const raw of erroredListeners) {
      const record = toListenerRecord(raw);
      expect(record).not.toBeNull();
      expect(record!.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record!.denial).toBeDefined();
      expect(record!.denial!.reasons.length).toBeGreaterThan(0);
      expect(record!.path).toBeDefined();
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials).toHaveLength(deniedRequests.length);
    for (let i = 0; i < deniedRequests.length; i++) {
      const raw = deniedRequests[i]!;
      const inspected = report.events.recentDenials[i]!;
      expect(inspected.reasons).toEqual(raw.reasons);
      if (raw.evaluatedRule !== undefined) {
        expect(inspected.rule).toMatchObject({
          citation: raw.evaluatedRule.citation,
          expression: raw.evaluatedRule.expression,
        });
      }
    }
  });

  it('projects RTDB write, read, and listener denials with reasons and matched rule', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'user-2' }));
    rtdbSandbox.setRules(db, RTDB_RULES);

    await expect(rtdbGet(rtdbRef(db, 'items/user-1'))).rejects.toThrow();
    await expect(rtdbSet(rtdbRef(db, 'items/user-1'), { title: 'blocked' })).rejects.toThrow();
    await awaitDeniedRtdbListener((onError) =>
      onValue(rtdbRef(db, 'items/user-1'), () => {}, onError),
    );

    const history = sandbox.history();
    const deniedOps = history.filter(
      (event): event is SandboxOperationEvent & SandboxEvent =>
        event.kind === 'operation' && event.service === 'rtdb' && event.result === 'deny',
    );
    expect(deniedOps.map((event) => event.method)).toEqual(['get', 'set', 'listen']);

    for (const raw of deniedOps) {
      const record = toOperationRecord(raw);
      expect(record).not.toBeNull();
      expect(record!.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record!.denial).toEqual({
        reasons: raw.reasons ?? [],
        rule: {
          path: '/items/$id',
          expression: 'auth.uid === $id',
        },
      });
    }

    const erroredListener = history.find(
      (event): event is SandboxListenerEvent & SandboxEvent =>
        event.kind === 'listener' && event.service === 'rtdb' && event.phase === 'errored',
    );
    expect(erroredListener).toBeDefined();
    for (const projected of [toOperationRecord(erroredListener!), toListenerRecord(erroredListener!)]) {
      expect(projected).not.toBeNull();
      expect(projected!.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(projected!.denial).toEqual({
        reasons: erroredListener!.reasons ?? [],
        rule: {
          path: '/items/$id',
          expression: 'auth.uid === $id',
        },
      });
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials.length).toBeGreaterThanOrEqual(4);
    for (const inspected of report.events.recentDenials) {
      expect(inspected.reasons).toBeDefined();
      expect(inspected.reasons!.length).toBeGreaterThan(0);
      expect(inspected.rule).toEqual({
        path: '/items/$id',
        expression: 'auth.uid === $id',
      });
    }
  });

  it('projects Storage write, read, and default-deny records with reasons and no fabricated rule', async () => {
    const sandbox = initializeSandbox();
    const adminStorage = getAdminStorageSandbox(sandbox, { dbName: storageDb('rules') });
    await replaceStorageRules(sandbox, STORAGE_RULES);
    await uploadBytes(
      storageRef(adminStorage, 'files/user-1/note.txt'),
      new Uint8Array([1, 2, 3]),
      { contentType: 'text/plain' },
    );

    const clientStorage = getStorageSandbox(sandbox.withAuth({ uid: 'user-2' }));
    await expect(getBytes(storageRef(clientStorage, 'files/user-1/note.txt'))).rejects.toThrow();
    await expect(
      uploadBytes(
        storageRef(clientStorage, 'files/user-1/note.txt'),
        new Uint8Array([4, 5, 6]),
        { contentType: 'text/plain' },
      ),
    ).rejects.toThrow();

    const deniedOps = sandbox.history().filter(
      (event): event is SandboxOperationEvent & SandboxEvent =>
        event.kind === 'operation' && event.service === 'storage' && event.result === 'deny',
    );
    expect(deniedOps.map((event) => event.method)).toEqual(['get', 'create']);

    for (const raw of deniedOps) {
      const record = toOperationRecord(raw);
      expect(record).not.toBeNull();
      expect(record!.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record!.denial).toEqual({ reasons: raw.reasons ?? [] });
      expect(record!.denial!.reasons[0]).toContain('match /files/{uid}/{name}');
      expect(record!.denial!.rule).toBeUndefined();
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials).toHaveLength(deniedOps.length);
    for (let i = 0; i < deniedOps.length; i++) {
      expect(report.events.recentDenials[i]!.reasons).toEqual(deniedOps[i]!.reasons);
    }

    // No-rules Storage default deny also exposes its denial reason without claiming rules evaluated.
    const unconfigured = initializeSandbox();
    const unconfiguredStorage = getStorageSandbox(unconfigured.withAuth({ uid: 'user-2' }), {
      dbName: storageDb('no-rules'),
    });
    await expect(getBytes(storageRef(unconfiguredStorage, 'files/a.txt'))).rejects.toThrow();
    const noRulesEvent = unconfigured.history().find(
      (event) => event.kind === 'operation' && event.service === 'storage' && event.result === 'deny',
    );
    expect(noRulesEvent).toBeDefined();
    const noRulesRecord = toOperationRecord(noRulesEvent!);
    expect(noRulesRecord!.rules).toEqual({ kind: 'not-evaluated', reason: 'no-rules' });
    expect(noRulesRecord!.denial).toEqual({
      reasons: ['No Storage rules configured; default deny.'],
    });
  });

  it('flags expired Firestore rules evidence and never leaves silent empty denial fields', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1' } });
    const deniedDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));
    const allowedDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));

    await expect(getDoc(doc(deniedDb, 'items/item-1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // Retention keeps 64 rulesEvidence snapshots; 65 subsequent evaluated requests evict the first.
    for (let i = 0; i < 65; i++) {
      await getDoc(doc(allowedDb, 'items/item-1'));
    }

    const firstDenial = sandbox.history().find(
      (event): event is RequestEvent & SandboxEvent =>
        event.kind === 'request' && event.result === 'deny',
    );
    expect(firstDenial).toBeDefined();
    expect(firstDenial!.rulesEvidence).toBeUndefined();
    expect(firstDenial!.rulesEvidenceExpired).toBe(true);

    const record = toOperationRecord(firstDenial!);
    expect(record!.denial).toBeDefined();
    expect(record!.denial!.evidenceExpired).toBe(true);
    expect(record!.denial!.reasons).toEqual(firstDenial!.reasons);
    expect(record!.denial!.rule?.citation).toBe(firstDenial!.evaluatedRule?.citation);
    expect(record!.denial!.rule?.expression).toBe(firstDenial!.evaluatedRule?.expression);

    const inspected = inspect(sandbox, { recentEventLimit: 10 }).events.recentDenials[0];
    expect(inspected?.evidenceExpired).toBe(true);
    expect(inspected?.reasons).toEqual(firstDenial!.reasons);

    // Even when a synthetic expired event carries empty reasons and no evaluatedRule, denial stays explicit.
    const bareExpired: SandboxEvent = {
      kind: 'request',
      id: 'req-expired-bare',
      at: 10,
      evalMs: 1,
      method: 'get',
      path: 'items/item-1',
      auth: null,
      result: 'deny',
      reasons: [],
      rulesEvidenceExpired: true,
      origin: 'user',
    };
    const bareRecord = toOperationRecord(bareExpired)!;
    expect(bareRecord.denial).toEqual({
      reasons: ['Firestore rules evidence expired.'],
      evidenceExpired: true,
    });
  });

  it('omits empty rule fields, deeply snapshots inputs, and omits denial on non-denials', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1' } });
    await getDoc(doc(getFirestore(sandbox.withAuth({ uid: 'user-1' })), 'items/item-1'));
    await getDoc(doc(getAdminFirestore(sandbox.withAuth(null)), 'items/item-1'));

    for (const event of sandbox.history()) {
      const record = toOperationRecord(event);
      if (record !== null) {
        expect(record.denial).toBeUndefined();
      }
    }

    // Empty matchedPath/matchedRule strings on RTDB events must not produce empty fields.
    const reasons = ['No rule granted access.'];
    const emptyRuleEvent: SandboxEvent = {
      kind: 'operation',
      id: 'rtdb-empty-rule',
      at: 20,
      service: 'rtdb',
      method: 'get',
      path: '/items/a',
      auth: null,
      result: 'deny',
      origin: 'user',
      reasons,
      rules: {
        engine: 'rtdb',
        matchedPath: '',
        matchedRule: '',
        reason: 'No rule granted access.',
      },
    };
    const record = toOperationRecord(emptyRuleEvent)!;
    reasons.push('mutated');
    expect(record.denial).toEqual({ reasons: ['No rule granted access.'] });
    expect(record.denial?.rule).toBeUndefined();

    // External-execution observed denials were not locally evaluated by rules.
    const observedDenial: SandboxEvent = {
      kind: 'operation',
      id: 'observed-deny',
      at: 30,
      service: 'firestore',
      method: 'getDoc',
      path: 'items/a',
      auth: { uid: 'user-2' },
      result: 'deny',
      origin: 'user',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'error', code: 'permission-denied' }, claimNames: [] },
    };
    expect(toOperationRecord(observedDenial)!.denial).toBeUndefined();
  });
});
