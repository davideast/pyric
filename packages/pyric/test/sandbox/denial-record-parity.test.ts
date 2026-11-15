/**
 * Denial diagnostics on canonical operation and listener records and on
 * `inspect()`.
 *
 * Plants real denials across every rules-evaluating service (Firestore,
 * Realtime Database, Storage) and every denial shape (write, read, list query
 * proof, listener), plus expired Firestore rules evidence and non-denial
 * listener errors, and asserts parity with the raw captured events.
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
  getDocs,
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

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
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
    await awaitDeniedListener((onError) => onSnapshot(doc(db, 'items/item-1'), () => {}, onError));
    await awaitDeniedListener((onError) => onSnapshot(collection(db, 'items'), () => {}, onError));

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
      const record = requireDefined(toOperationRecord(raw), `operation record for ${raw.id}`);
      expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      const denial = requireDefined(record.denial, `denial for ${raw.id}`);
      expect(denial.reasons).toEqual(raw.reasons);
      expect(denial.reasons.length).toBeGreaterThan(0);
      expect(Object.isFrozen(denial)).toBe(true);
      expect(Object.isFrozen(denial.reasons)).toBe(true);
      if (raw.evaluatedRule !== undefined) {
        const rule = requireDefined(denial.rule, `rule for ${raw.id}`);
        expect(rule.expression).toBe(raw.evaluatedRule.expression);
        expect(rule.citation).toBe(raw.evaluatedRule.citation);
        expect(rule.line).toBe(raw.evaluatedRule.line);
        expect(rule.path).toBe('/items/{id}');
        expect(Object.isFrozen(rule)).toBe(true);
      }
    }

    const erroredListeners = history.filter((event) => event.kind === 'listener_errored');
    expect(erroredListeners).toHaveLength(2);
    for (const raw of erroredListeners) {
      const record = requireDefined(toListenerRecord(raw), `listener record for ${raw.id}`);
      expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      const denial = requireDefined(record.denial, `listener denial for ${raw.id}`);
      expect(denial.reasons.length).toBeGreaterThan(0);
      expect(record.path).toBeDefined();
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials).toHaveLength(deniedRequests.length);
    for (let i = 0; i < deniedRequests.length; i++) {
      const raw = requireDefined(deniedRequests[i], `deniedRequests[${i}]`);
      const inspected = requireDefined(report.events.recentDenials[i], `recentDenials[${i}]`);
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
    await awaitDeniedListener((onError) => onValue(rtdbRef(db, 'items/user-1'), () => {}, onError));

    const history = sandbox.history();
    const deniedOps = history.filter(
      (event): event is SandboxOperationEvent & SandboxEvent =>
        event.kind === 'operation' && event.service === 'rtdb' && event.result === 'deny',
    );
    expect(deniedOps.map((event) => event.method)).toEqual(['get', 'set', 'listen']);

    for (const raw of deniedOps) {
      const record = requireDefined(toOperationRecord(raw), `rtdb record for ${raw.id}`);
      expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record.denial).toEqual({
        reasons: raw.reasons ?? [],
        rule: {
          path: '/items/$id',
          expression: 'auth.uid === $id',
        },
      });
    }

    const erroredListener = requireDefined(
      history.find(
        (event): event is SandboxListenerEvent & SandboxEvent =>
          event.kind === 'listener' && event.service === 'rtdb' && event.phase === 'errored',
      ),
      'rtdb errored listener event',
    );
    const projections = [toOperationRecord(erroredListener), toListenerRecord(erroredListener)];
    for (const projected of projections) {
      const record = requireDefined(projected, 'rtdb listener projection');
      expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      expect(record.denial).toEqual({
        reasons: erroredListener.reasons ?? [],
        rule: {
          path: '/items/$id',
          expression: 'auth.uid === $id',
        },
      });
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials.length).toBeGreaterThanOrEqual(4);
    for (const inspected of report.events.recentDenials) {
      const reasons = requireDefined(inspected.reasons, 'inspected rtdb reasons');
      expect(reasons.length).toBeGreaterThan(0);
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
      const record = requireDefined(toOperationRecord(raw), `storage record for ${raw.id}`);
      expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
      const denial = requireDefined(record.denial, `storage denial for ${raw.id}`);
      expect(denial).toEqual({ reasons: raw.reasons ?? [] });
      expect(denial.reasons[0]).toContain('match /files/{uid}/{name}');
      expect(denial.rule).toBeUndefined();
    }

    const report = inspect(sandbox, { recentEventLimit: 10 });
    expect(report.events.recentDenials).toHaveLength(deniedOps.length);
    for (let i = 0; i < deniedOps.length; i++) {
      const raw = requireDefined(deniedOps[i], `storage deniedOps[${i}]`);
      const inspected = requireDefined(report.events.recentDenials[i], `recentDenials[${i}]`);
      expect(inspected.reasons).toEqual(raw.reasons);
    }

    // No-rules Storage default deny exposes its denial reason without claiming rules evaluated.
    const unconfigured = initializeSandbox();
    const unconfiguredStorage = getStorageSandbox(unconfigured.withAuth({ uid: 'user-2' }), {
      dbName: storageDb('no-rules'),
    });
    await expect(getBytes(storageRef(unconfiguredStorage, 'files/a.txt'))).rejects.toThrow();
    const noRulesEvent = requireDefined(
      unconfigured
        .history()
        .find(
          (event) =>
            event.kind === 'operation' && event.service === 'storage' && event.result === 'deny',
        ),
      'storage no-rules event',
    );
    const noRulesRecord = requireDefined(
      toOperationRecord(noRulesEvent),
      'storage no-rules record',
    );
    expect(noRulesRecord.rules).toEqual({ kind: 'not-evaluated', reason: 'no-rules' });
    expect(noRulesRecord.denial).toEqual({
      reasons: ['No Storage rules configured; default deny.'],
    });
  });

  it('preserves Firestore query-proof citation and column before and after rulesEvidence expiry', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, FIRESTORE_RULES);
    seedDocuments(sandbox, { 'items/item-1': { owner: 'user-1' } });
    const deniedDb = getFirestore(sandbox.withAuth({ uid: 'user-2' }));
    const allowedDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));

    await expect(getDocs(collection(deniedDb, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const rawBefore = requireDefined(
      sandbox.history().find(
        (event): event is RequestEvent & SandboxEvent =>
          event.kind === 'request' && event.method === 'list' && event.result === 'deny',
      ),
      'query-proof denial before expiry',
    );
    const proofRule = requireDefined(rawBefore.queryProof?.failures[0]?.rule, 'queryProof rule');
    expect(proofRule.citation).toBeDefined();
    expect(proofRule.column).toBeDefined();

    const recordBefore = requireDefined(
      toOperationRecord(rawBefore),
      'query-proof record before expiry',
    );
    const ruleBefore = requireDefined(recordBefore.denial?.rule, 'denial.rule before expiry');
    expect(ruleBefore.citation).toBe(proofRule.citation);
    expect(ruleBefore.line).toBe(proofRule.line);
    expect(ruleBefore.column).toBe(proofRule.column);
    expect(ruleBefore.expression).toBe(proofRule.expression);

    // Retention keeps 64 rulesEvidence snapshots; 65 subsequent reads evict the first.
    for (let i = 0; i < 65; i++) {
      await getDoc(doc(allowedDb, 'items/item-1'));
    }

    const rawAfter = requireDefined(
      sandbox.history().find(
        (event): event is RequestEvent & SandboxEvent =>
          event.kind === 'request' && event.method === 'list' && event.result === 'deny',
      ),
      'query-proof denial after expiry',
    );
    expect(rawAfter.rulesEvidence).toBeUndefined();
    expect(rawAfter.rulesEvidenceExpired).toBe(true);

    const recordAfter = requireDefined(
      toOperationRecord(rawAfter),
      'query-proof record after expiry',
    );
    const denialAfter = requireDefined(recordAfter.denial, 'denial after expiry');
    expect(denialAfter.evidenceExpired).toBe(true);
    expect(denialAfter.reasons).toEqual(rawAfter.reasons);
    const ruleAfter = requireDefined(denialAfter.rule, 'denial.rule after expiry');
    expect(ruleAfter.citation).toBe(proofRule.citation);
    expect(ruleAfter.line).toBe(proofRule.line);
    expect(ruleAfter.column).toBe(proofRule.column);
    expect(ruleAfter.expression).toBe(proofRule.expression);

    const inspected = requireDefined(
      inspect(sandbox, { recentEventLimit: 10 }).events.recentDenials[0],
      'inspected expired query-proof denial',
    );
    expect(inspected.evidenceExpired).toBe(true);
    expect(inspected.reasons).toEqual(rawAfter.reasons);
    expect(inspected.rule).toEqual(ruleAfter);
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
    for (let i = 0; i < 65; i++) {
      await getDoc(doc(allowedDb, 'items/item-1'));
    }

    const firstDenial = requireDefined(
      sandbox.history().find(
        (event): event is RequestEvent & SandboxEvent =>
          event.kind === 'request' && event.result === 'deny',
      ),
      'expired getDoc denial',
    );
    expect(firstDenial.rulesEvidence).toBeUndefined();
    expect(firstDenial.rulesEvidenceExpired).toBe(true);

    const record = requireDefined(toOperationRecord(firstDenial), 'expired getDoc record');
    const denial = requireDefined(record.denial, 'expired getDoc denial');
    expect(denial.evidenceExpired).toBe(true);
    expect(denial.reasons).toEqual(firstDenial.reasons);
    expect(denial.rule?.citation).toBe(firstDenial.evaluatedRule?.citation);
    expect(denial.rule?.expression).toBe(firstDenial.evaluatedRule?.expression);

    const inspected = requireDefined(
      inspect(sandbox, { recentEventLimit: 10 }).events.recentDenials[0],
      'inspected expired getDoc denial',
    );
    expect(inspected.evidenceExpired).toBe(true);
    expect(inspected.reasons).toEqual(firstDenial.reasons);

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
    const bareRecord = requireDefined(toOperationRecord(bareExpired), 'bare expired record');
    expect(bareRecord.denial).toEqual({
      reasons: ['Firestore rules evidence expired.'],
      evidenceExpired: true,
    });
  });

  it('classifies non-permission-denied listener_errored as runtime errors without denial', () => {
    const unavailableListener: SandboxEvent = JSON.parse(
      JSON.stringify({
        kind: 'listener_errored',
        id: 'err-unavailable',
        at: 40,
        listenerId: 'l-unavail',
        target: { kind: 'doc', path: 'items/item-1' },
        auth: { uid: 'user-2' },
        error: { code: 'unavailable', message: 'stream disconnected' },
      }),
    );
    const unavailableRecord = requireDefined(
      toListenerRecord(unavailableListener),
      'unavailable listener record',
    );
    expect(unavailableRecord.result).toBe('error');
    expect(unavailableRecord.rules).toEqual({
      kind: 'not-evaluated',
      reason: 'runtime-error',
    });
    expect(unavailableRecord.denial).toBeUndefined();

    const nullErrorDenied: SandboxEvent = JSON.parse(
      JSON.stringify({
        kind: 'operation',
        id: 'op-null-error',
        at: 41,
        service: 'rtdb',
        method: 'get',
        path: '/items/a',
        auth: null,
        result: 'deny',
        origin: 'user',
        error: null,
      }),
    );
    const nullErrorRecord = requireDefined(
      toOperationRecord(nullErrorDenied),
      'null-error denied record',
    );
    expect(nullErrorRecord.denial).toEqual({ reasons: ['Denied by security rules.'] });

    const errorlessListener: SandboxEvent = {
      kind: 'listener_errored',
      id: 'err-empty',
      at: 42,
      listenerId: 'l-empty',
      target: { kind: 'doc', path: 'items/item-1' },
      auth: null,
    };
    const errorlessRecord = requireDefined(
      toListenerRecord(errorlessListener),
      'errorless listener record',
    );
    expect(errorlessRecord.result).toBe('error');
    expect(errorlessRecord.rules).toEqual({
      kind: 'not-evaluated',
      reason: 'runtime-error',
    });
    expect(errorlessRecord.denial).toBeUndefined();
  });

  it('omits empty or allow-only rule fields, snapshots inputs, and omits denial on non-denials', async () => {
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
    const record = requireDefined(toOperationRecord(emptyRuleEvent), 'empty-rule rtdb record');
    reasons.push('mutated');
    expect(record.denial).toEqual({ reasons: ['No rule granted access.'] });
    expect(record.denial?.rule).toBeUndefined();

    // Evidence containing only ALLOW entries must not be picked as a denying rule.
    const allowOnlyEvidenceDenial: SandboxEvent = {
      kind: 'request',
      id: 'req-allow-only-evidence',
      at: 25,
      evalMs: 1,
      method: 'get',
      path: 'items/item-1',
      auth: null,
      result: 'deny',
      reasons: ['Denied by security rules.'],
      origin: 'user',
      rulesEvidence: {
        version: '1',
        scope: 'request',
        decision: 'DENY',
        truncated: false,
        paths: [],
        rules: [
          {
            path: '/items/{id}',
            expression: 'true',
            line: 5,
            verdict: 'ALLOW',
            checks: [],
          },
        ],
      },
    };
    const allowOnlyRecord = requireDefined(
      toOperationRecord(allowOnlyEvidenceDenial),
      'allow-only evidence record',
    );
    expect(allowOnlyRecord.denial?.rule).toBeUndefined();

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
    const observedRecord = requireDefined(toOperationRecord(observedDenial), 'observed record');
    expect(observedRecord.denial).toBeUndefined();
  });
});
