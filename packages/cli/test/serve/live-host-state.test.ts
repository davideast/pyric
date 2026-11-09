/**
 * The live status a live host keeps: it counts each observed call the host
 * accepted, and names the project the app's Firebase config named, with a
 * warning when that differs from the project the host was started for.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import { readLiveHostStatus } from 'pyric/sandbox/internal';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import type { ServedFirebaseSpecifier } from '../../src/serve/firebase-module-swap.js';
import { createLiveHostState, projectSourceName } from '../../src/serve/live-host-state.js';
import { refuseInvalidInboundMessage } from '../../src/serve/worker/inbound-validation.js';

function observe(id: string, call: Partial<ObservedCall> & { method: string }, clientSessionId = 'client-1'): BridgeMessage {
  const full = { service: 'firestore', at: 1, outcome: { status: 'ok' }, ...call };
  return { type: 'worker-message', clientSessionId, message: { t: 'observe', id, call: full } } as unknown as BridgeMessage;
}

function reply(id: string, ok: boolean, clientSessionId = 'client-1'): BridgeMessage {
  const message = ok ? { t: 'res', id, ok: true, value: undefined } : { t: 'res', id, ok: false, error: { code: 'resource-exhausted', message: 'busy' } };
  return { type: 'worker-message-result', clientSessionId, message } as unknown as BridgeMessage;
}

function state(configProjectId = 'staging') {
  const warnings: string[] = [];
  // Its own empty unobserved source: the default reads the process's ledger, which other test files in this process fill.
  const live = createLiveHostState({
    configProjectId,
    configSource: 'firebaserc',
    optionName: '--project',
    warn: (line) => warnings.push(line),
    unobserved: () => [],
  });
  const call = (id: string, observed: Partial<ObservedCall> & { method: string }, ok = true, clientSessionId = 'client-1') => {
    live.inbound(observe(id, observed, clientSessionId));
    live.outbound(reply(id, ok, clientSessionId));
  };
  return { live, warnings, call };
}

describe('the live host state', () => {
  it('names the host project until a call names the app\'s own', () => {
    const { live } = state();
    expect(live.report()).toEqual({
      projectId: 'staging',
      configProjectId: 'staging',
      configSource: '.firebaserc',
      appProjectIds: [],
      billed: { reads: 0, writes: 0, deliveries: 0 },
      admin: { mode: 'observed', observed: true, bypassesRules: true },
    });
  });

  it('counts each call the host accepted, by kind, and leaves out the rest', () => {
    const { live, call } = state();
    call('1', { method: 'getDoc' });
    call('2', { method: 'setDoc' });
    call('3', { method: 'runTransaction' });
    call('4', { method: 'onSnapshot' });
    call('5', { method: 'onSnapshot' }, true, 'client-2');
    call('6', { method: 'getDocFromCache' });
    call('7', { method: 'signInAnonymously', service: 'auth' });
    call('8', { method: 'getDoc', outcome: { status: 'error', code: 'permission-denied' } });
    // The host refused this one (its budget was full), so production's answer never became a row.
    call('9', { method: 'getDoc' }, false);
    expect(live.report().billed).toEqual({ reads: 1, writes: 2, deliveries: 2 });
  });

  it('counts the documents each listener delivery was billed for, and nothing for a metadata-only one', () => {
    const { live, call } = state();
    // A listener with includeMetadataChanges: its first snapshot, a pending write, the write acknowledged, a change from another client.
    call('1', { method: 'onSnapshot', billedDocuments: 3 });
    call('2', { method: 'onSnapshot', billedDocuments: 1 });
    call('3', { method: 'onSnapshot', billedDocuments: 0 });
    call('4', { method: 'onSnapshot', billedDocuments: 1 });
    // A client that names no count still counts its delivery once.
    call('5', { method: 'onSnapshot' });
    expect(live.report().billed).toEqual({ reads: 0, writes: 0, deliveries: 6 });
  });

  it('counts nothing for a malformed record, a frame of another kind, or a reply to no observed call', () => {
    const { live } = state();
    live.inbound({ type: 'worker-message', clientSessionId: 'client-1', message: { t: 'observe', id: '1', call: { method: 'getDoc' } } } as unknown as BridgeMessage);
    live.outbound(reply('1', true));
    live.inbound({ type: 'worker-message', clientSessionId: 'client-1', message: { t: 'op', id: '2', op: 'get' } } as unknown as BridgeMessage);
    live.outbound(reply('2', true));
    live.outbound(reply('3', true));
    expect(live.report().billed).toEqual({ reads: 0, writes: 0, deliveries: 0 });
  });

  it("names the project the app's Firebase config named, and warns once when it differs from the host's", () => {
    const { live, warnings, call } = state('staging');
    call('1', { method: 'getDoc', projectId: 'prod' });
    call('2', { method: 'getDoc', projectId: 'prod' });
    expect(live.report()).toMatchObject({ projectId: 'prod', configProjectId: 'staging', appProjectIds: ['prod'] });
    expect(warnings).toEqual([
      'Live mode: your app\'s calls go to the Firebase project prod, not staging. ' +
        'Your Firebase config says prod; .firebaserc says staging. The chip and Studio show "prod".',
    ]);
  });

  it('warns about nothing when the app calls the host project', () => {
    const { live, warnings, call } = state('staging');
    call('1', { method: 'getDoc', projectId: 'staging' });
    expect(live.report().projectId).toBe('staging');
    expect(warnings).toEqual([]);
  });

  it('reports the imports the app resolved to live rows, read at report time, in first-import order', () => {
    const imports = new Set<ServedFirebaseSpecifier>();
    const live = createLiveHostState({ configProjectId: 'staging', configSource: 'firebaserc', optionName: '--project', warn: () => undefined, observed: imports });
    expect(live.report()).not.toHaveProperty('observed');
    // Imports arrive as the app loads, after the host started.
    imports.add('firebase/firestore');
    imports.add('firebase/auth');
    expect(live.report().observed).toEqual(['firebase/firestore', 'firebase/auth']);
  });

  it('reads an observed-imports function each report and lists each import once', () => {
    const resolved: ServedFirebaseSpecifier[] = [];
    const live = createLiveHostState({ configProjectId: 'staging', configSource: 'firebaserc', optionName: '--project', warn: () => undefined, observed: () => resolved });
    expect(live.report()).not.toHaveProperty('observed');
    resolved.push('firebase/database', 'firebase/storage', 'firebase/database');
    expect(live.report().observed).toEqual(['firebase/database', 'firebase/storage']);
    resolved.push('firebase/ai');
    expect(live.report().observed).toEqual(['firebase/database', 'firebase/storage', 'firebase/ai']);
  });

  it('leaves observed out of the report when its source throws, so the health report still answers', () => {
    const live = createLiveHostState({
      configProjectId: 'staging',
      configSource: 'firebaserc',
      optionName: '--project',
      warn: () => undefined,
      observed: () => { throw new Error('not ready'); },
    });
    expect(live.report()).not.toHaveProperty('observed');
    expect(live.report().projectId).toBe('staging');
  });

  it('reports the Admin SDK as observed on every live host, apart from the passed-through imports', () => {
    const input = { configProjectId: 'staging', configSource: 'firebaserc', optionName: '--project', warn: () => undefined } as const;
    const admin = { mode: 'observed', observed: true, bypassesRules: true };
    expect(createLiveHostState(input).report().admin).toEqual(admin);
    const live = createLiveHostState({ ...input, passThrough: ['firebase/functions'] });
    expect(live.report().admin).toEqual(admin);
    expect(live.report().passThrough).toEqual(['firebase/functions']);
    expect(readLiveHostStatus({ live: live.report() })?.admin).toEqual(admin);
  });

  it('names each project source as the developer set it', () => {
    expect(projectSourceName('firebaserc', '--project')).toBe('.firebaserc');
    expect(projectSourceName('firebase-use', '--project')).toBe('`firebase use`');
    expect(projectSourceName('option', '--project')).toBe('--project');
    expect(projectSourceName('PYRIC_PROJECT', '--project')).toBe('PYRIC_PROJECT');
  });
});

describe('the live host state\'s observed session data', () => {
  /**
   * Sends one observe frame the way a live host does: the live host state sees
   * it first, then the worker's inbound validation, whose refusal (or the
   * dispatch's ok) is the reply the live host state reads.
   */
  function sendThroughValidation(live: ReturnType<typeof createLiveHostState>, id: string, call: Record<string, unknown>, sessionData?: unknown) {
    const inner: Record<string, unknown> = { t: 'observe', id, call: { service: 'firestore', at: 1, outcome: { status: 'ok' }, ...call } };
    if (sessionData !== undefined) inner.sessionData = sessionData;
    live.inbound({ type: 'worker-message', clientSessionId: 'client-1', message: inner } as unknown as BridgeMessage);
    const posted: unknown[] = [];
    const refused = refuseInvalidInboundMessage({ postMessage: (message: unknown) => posted.push(message) } as never, inner);
    const message = refused ? posted[0] : { t: 'res', id, ok: true, value: undefined };
    live.outbound({ type: 'worker-message-result', clientSessionId: 'client-1', message } as unknown as BridgeMessage);
    return { refused, inner };
  }

  it('bills and prints a call whose session data is malformed or oversized, and counts only the data as skipped', () => {
    const printed: string[] = [];
    const live = createLiveHostState({
      configProjectId: 'demo-live',
      configSource: 'firebaserc',
      optionName: '--project',
      warn: () => {},
      print: (line) => printed.push(line),
      unobserved: () => [],
    });

    const oversized = sendThroughValidation(
      live,
      'too-big',
      { method: 'getDoc', path: 'rooms/too-big' },
      { firestore: [{ kind: 'set', path: 'rooms/too-big', data: { blob: 'z'.repeat(1_100_000) } }] },
    );
    const malformed = sendThroughValidation(
      live,
      'bad-shape',
      { method: 'getDoc', path: 'rooms/bad-shape' },
      { firestore: [{ kind: 'set', path: 'not-a-doc-path', data: {} }] },
    );
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 25; level++) deep = { child: deep };
    sendThroughValidation(live, 'too-deep', { method: 'getDoc', path: 'rooms/too-deep' }, {
      firestore: [{ kind: 'set', path: 'rooms/too-deep', data: deep }],
    });

    expect(oversized.refused).toBe(false);
    expect(malformed.refused).toBe(false);
    expect('sessionData' in oversized.inner).toBe(false);
    expect('sessionData' in malformed.inner).toBe(false);
    expect(live.report().billed).toEqual({ reads: 3, writes: 0, deliveries: 0 });
    expect(live.sessionData.snapshot().skips).toEqual({ oversized: 1, unsupported: 2, truncated: 0, failed: 0, admin: 0 });
    expect(live.sessionData.snapshot().firestore).toEqual({});
  });

  it('keeps valid client and Admin session data with SDK provenance, counts failed calls, and counts no skip for a listener attach', () => {
    const { live } = state('demo-live');
    sendThroughValidation(live, 'attach', {
      service: 'rtdb',
      method: 'onValue',
      instance: 'demo-live-default-rtdb',
      path: '/rooms',
      listener: { phase: 'attach', id: 'l-1', target: '/rooms' },
    });
    sendThroughValidation(live, 'denied', {
      service: 'rtdb',
      method: 'get',
      instance: 'demo-live-default-rtdb',
      path: '/secret',
      outcome: { status: 'error', code: 'permission-denied' },
    });
    sendThroughValidation(
      live,
      'admin-failed',
      { method: 'DocumentReference.set', sdk: 'admin', path: 'rooms/admin-failed', outcome: { status: 'error', code: 'unavailable' } },
      { firestore: [{ kind: 'set', path: 'rooms/admin-failed', data: { shouldNotApply: true } }] },
    );
    sendThroughValidation(
      live,
      'auth-admin-ignored',
      { service: 'auth', method: 'Auth.getUser', sdk: 'admin' },
      { firestore: [{ kind: 'set', path: 'rooms/forged-from-auth', data: { bad: true } }] },
    );
    sendThroughValidation(
      live,
      'admin-read',
      { method: 'DocumentReference.get', sdk: 'admin', path: 'rooms/admin-read' },
      { firestore: [{ kind: 'set', path: 'rooms/admin-read', data: { seededBy: 'admin' } }] },
    );
    expect(live.sessionData.snapshot().sources).toEqual({ client: false, admin: true });

    const valid = sendThroughValidation(
      live,
      'read',
      { method: 'getDoc', path: 'rooms/r1' },
      { firestore: [{ kind: 'set', path: 'rooms/r1', data: { title: 'One' } }] },
    );

    expect(valid.refused).toBe(false);
    const snapshot = live.sessionData.snapshot();
    expect(snapshot.firestore).toEqual({
      'rooms/admin-read': { seededBy: 'admin' },
      'rooms/r1': { title: 'One' },
    });
    expect(snapshot.sources).toEqual({ client: true, admin: true });
    expect(snapshot.skips).toEqual({ oversized: 0, unsupported: 0, truncated: 0, failed: 2, admin: 0 });
  });

  it('accepts client and Admin Storage metadata deltas with SDK provenance while ignoring non-session services and counting failed Storage calls', () => {
    const { live } = state('demo-live');
    sendThroughValidation(
      live,
      'storage-client',
      { service: 'storage', method: 'uploadBytes', bucket: 'demo-live.firebasestorage.app', path: 'items/a.png' },
      {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-live.firebasestorage.app',
            fullPath: 'items/a.png',
            metadata: { size: 256, contentType: 'image/png' },
          },
        ],
      },
    );
    expect(live.sessionData.snapshot().sources).toEqual({ client: true, admin: false });

    sendThroughValidation(
      live,
      'storage-admin',
      { service: 'storage', sdk: 'admin', method: 'File.save', bucket: 'demo-live-secondary', path: 'items/b.txt' },
      {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-live-secondary',
            fullPath: 'items/b.txt',
            metadata: { size: 32, contentType: 'text/plain' },
          },
        ],
      },
    );
    sendThroughValidation(
      live,
      'auth-admin-with-synthetic-delta',
      { service: 'auth', sdk: 'admin', method: 'Auth.getUser' },
      {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-live-secondary',
            fullPath: 'items/from-admin-auth.txt',
            metadata: { size: 1 },
          },
        ],
      },
    );
    sendThroughValidation(
      live,
      'auth-with-synthetic-delta',
      { service: 'auth', method: 'signInAnonymously' },
      {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-live.firebasestorage.app',
            fullPath: 'items/from-auth.png',
            metadata: { size: 1 },
          },
        ],
      },
    );
    sendThroughValidation(live, 'storage-denied', {
      service: 'storage',
      method: 'getMetadata',
      bucket: 'demo-live.firebasestorage.app',
      path: 'items/secret.png',
      outcome: { status: 'error', code: 'storage/unauthorized' },
    });
    sendThroughValidation(
      live,
      'storage-admin-failed',
      {
        service: 'storage',
        sdk: 'admin',
        method: 'File.save',
        bucket: 'demo-live-secondary',
        path: 'items/failed.txt',
        outcome: { status: 'error', code: '503' },
      },
      {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-live-secondary',
            fullPath: 'items/failed.txt',
            metadata: { size: 99 },
          },
        ],
      },
    );

    const snapshot = live.sessionData.snapshot();
    expect(snapshot.firestore).toEqual({});
    expect(snapshot.sources).toEqual({ client: true, admin: true });
    expect(snapshot.stats.storageBuckets).toBe(2);
    expect(snapshot.stats.storageObjects).toBe(2);
    expect(snapshot.storage?.['demo-live.firebasestorage.app']?.objects['items/a.png']?.size).toBe(256);
    expect(snapshot.storage?.['demo-live-secondary']?.objects['items/b.txt']?.size).toBe(32);
    expect(snapshot.skips).toEqual({ oversized: 0, unsupported: 0, truncated: 0, failed: 2, admin: 0 });
  });

  it('invalidates prior Firestore and RTDB coverage when a successful write is skipped, oversized, truncated, or issued via Admin SDK (#2540 F1)', () => {
    const { live } = state('demo-live');
    live.sessionData.apply({
      firestore: [
        { kind: 'set', path: 'rooms/r1', data: { locked: false } },
        { kind: 'delete', path: 'bans/u-1' },
      ],
      rtdb: [
        { kind: 'set', instance: 'demo-live-default-rtdb', path: '/banned/u-1', value: null },
      ],
    });
    expect(live.sessionData.getFirestoreDoc('rooms/r1')).toEqual({
      status: 'complete',
      data: { locked: false },
    });
    expect(live.sessionData.getFirestoreDoc('bans/u-1')).toEqual({ status: 'absent' });
    expect(live.sessionData.getRtdbInstance('demo-live-default-rtdb').isPathKnown('/banned/u-1')).toBe(true);

    // 1. Skipped RTDB client write (`runTransaction` / converter) invalidates `/banned/u-1`.
    sendThroughValidation(
      live,
      'rtdb-skip',
      {
        service: 'rtdb',
        method: 'runTransaction',
        instance: 'demo-live-default-rtdb',
        path: '/banned/u-1',
      },
      { skipped: { unsupported: 1 } },
    );
    expect(live.sessionData.getRtdbInstance('demo-live-default-rtdb').isPathKnown('/banned/u-1')).toBe(false);

    // 2. Admin SDK Firestore write invalidates `rooms/r1`.
    sendThroughValidation(live, 'admin-write', {
      service: 'firestore',
      sdk: 'admin',
      method: 'DocumentReference.update',
      path: 'rooms/r1',
    });
    expect(live.sessionData.getFirestoreDoc('rooms/r1')).toEqual({ status: 'unobserved' });

    // 3. Oversized rejected Firestore write invalidates `bans/u-1` tombstone.
    sendThroughValidation(
      live,
      'oversized-write',
      { service: 'firestore', method: 'setDoc', path: 'bans/u-1' },
      { firestore: [{ kind: 'set', path: 'bans/u-1', data: { blob: 'z'.repeat(1_100_000) } }] },
    );
    expect(live.sessionData.getFirestoreDoc('bans/u-1')).toEqual({ status: 'unobserved' });

    // 4. Truncated writeBatch invalidates all Firestore coverage since omitted batch targets are unknown.
    live.sessionData.apply({
      firestore: [{ kind: 'set', path: 'items/kept-before-batch', data: { ok: true } }],
    });
    sendThroughValidation(
      live,
      'truncated-batch',
      { service: 'firestore', method: 'writeBatch' },
      {
        firestore: [{ kind: 'set', path: 'items/in-batch', data: { ok: true } }],
        skipped: { truncated: 1 },
      },
    );
    expect(live.sessionData.getFirestoreDoc('items/kept-before-batch')).toEqual({ status: 'unobserved' });
  });

  it('invalidates prior coverage on skipped/rejected reads and deliveries, onDisconnect/setPriority writes, ambiguous write errors, and pending-call eviction (#2540 N3, N5, L1)', () => {
    const { live } = state('demo-live');
    const inst = 'demo-live-default-rtdb';

    // N3: Oversized getDoc read invalidates prior complete doc coverage while preserving Studio UI snapshot data.
    live.sessionData.apply({
      firestore: [
        { kind: 'set', path: 'spaces/s1', data: { members: ['u-1', 'u-2'] } },
        { kind: 'delete', path: 'spaces/missing' },
      ],
    });
    sendThroughValidation(
      live,
      'oversized-read',
      { service: 'firestore', method: 'getDoc', path: 'spaces/s1' },
      { skipped: { oversized: 1 } },
    );
    expect(live.sessionData.getFirestoreDoc('spaces/s1')).toEqual({ status: 'unobserved' });

    // N3: Skipped Query.get (e.g. Query.select projection) invalidates collection doc and absent tombstones in coverage.
    live.sessionData.apply({
      firestore: [{ kind: 'set', path: 'spaces/s1', data: { members: ['u-1'] } }],
    });
    sendThroughValidation(
      live,
      'projected-query-read',
      { service: 'firestore', method: 'Query.get', sdk: 'admin', path: 'spaces' },
      { skipped: { unsupported: 1 } },
    );
    expect(live.sessionData.getFirestoreDoc('spaces/s1')).toEqual({ status: 'unobserved' });
    expect(live.sessionData.getFirestoreDoc('spaces/missing')).toEqual({ status: 'unobserved' });
    expect(live.sessionData.snapshot().firestore['spaces/s1']).toEqual({ members: ['u-1'] });

    // N5: Malformed delivery delta rejected by readObservedSessionDelta still invalidates `call.path`.
    live.sessionData.apply({
      rtdb: [{ kind: 'set', instance: inst, path: '/slots/s1', value: 'open' }],
    });
    sendThroughValidation(
      live,
      'bad-delivery',
      { service: 'rtdb', method: 'onValue', instance: inst, path: '/slots/s1' },
      { rtdb: [{ kind: 'invalidate', instance: inst, path: '/slots/bad.key' }] },
    );
    expect(live.sessionData.getRtdbInstance(inst).isPathKnown('/slots/s1')).toBe(false);

    // N5 + mutation kills: `onDisconnect.*` and `setPriority` invalidate target RTDB coverage.
    for (const method of [
      'onDisconnect.set',
      'onDisconnect.update',
      'onDisconnect.remove',
      'onDisconnect.setWithPriority',
      'setPriority',
    ]) {
      live.sessionData.apply({
        rtdb: [{ kind: 'set', instance: inst, path: '/presence/u-1', value: 'online' }],
      });
      expect(live.sessionData.getRtdbInstance(inst).isPathKnown('/presence/u-1')).toBe(true);
      sendThroughValidation(live, `mut-${method}`, {
        service: 'rtdb',
        method,
        instance: inst,
        path: '/presence/u-1',
      });
      expect(live.sessionData.getRtdbInstance(inst).isPathKnown('/presence/u-1')).toBe(false);
    }

    // L1: Definitive rules denial (`permission-denied`) preserves authoritative coverage,
    // whereas an ambiguous write error (`deadline-exceeded`) invalidates `call.path`.
    live.sessionData.apply({
      firestore: [{ kind: 'set', path: 'orders/o-1', data: { status: 'open' } }],
    });
    sendThroughValidation(live, 'denied-write', {
      service: 'firestore',
      method: 'updateDoc',
      path: 'orders/o-1',
      outcome: { status: 'error', code: 'permission-denied' },
    });
    expect(live.sessionData.getFirestoreDoc('orders/o-1')).toEqual({
      status: 'complete',
      data: { status: 'open' },
    });

    sendThroughValidation(live, 'ambiguous-write', {
      service: 'firestore',
      method: 'DocumentReference.update',
      sdk: 'admin',
      path: 'orders/o-1',
      outcome: { status: 'error', code: 'deadline-exceeded' },
    });
    expect(live.sessionData.getFirestoreDoc('orders/o-1')).toEqual({ status: 'unobserved' });

    // L1: Overflowing MAX_PENDING_CALLS (4096) invalidates an evicted pending write's target.
    live.sessionData.apply({
      firestore: [{ kind: 'set', path: 'orders/evicted', data: { status: 'open' } }],
    });
    live.inbound({
      type: 'worker-message',
      clientSessionId: 'client-1',
      message: {
        t: 'observe',
        id: 'pending-0',
        call: {
          service: 'firestore',
          method: 'updateDoc',
          path: 'orders/evicted',
          at: 1,
          outcome: { status: 'ok' },
        },
      },
    } as unknown as BridgeMessage);
    for (let i = 1; i <= 4096; i++) {
      live.inbound({
        type: 'worker-message',
        clientSessionId: 'client-1',
        message: {
          t: 'observe',
          id: `pending-${i}`,
          call: {
            service: 'firestore',
            method: 'getDoc',
            path: 'orders/other',
            at: 1,
            outcome: { status: 'ok' },
          },
        },
      } as unknown as BridgeMessage);
    }
    expect(live.sessionData.getFirestoreDoc('orders/evicted')).toEqual({ status: 'unobserved' });
  });
});
