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
});
