/**
 * Sandbox RTDB permission errors carry a structured `denialContext`, the way
 * sandbox Firestore errors do: an own, enumerable `denialContext` property
 * whose `engine` discriminator is `'rtdb'`. The error itself keeps the shape
 * production's `firebase/database` SDK throws (plain `Error`, production's
 * message and code), which `oracle-conformance.test.ts` replays from the
 * captured observations.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import type { RtdbDenialContext, SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import {
  getDatabase,
  get,
  limitToFirst,
  onDisconnect,
  orderByKey,
  query,
  onChildAdded,
  onValue,
  ref,
  remove,
  runTransaction,
  set,
  setPriority,
  update,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

const RULES = {
  rules: {
    rooms: {
      $roomId: {
        '.read': 'auth.uid == $roomId',
        '.write': 'auth.uid == $roomId',
        score: { '.validate': 'newData.isNumber()' },
      },
    },
  },
};

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  rtdbSandbox.setRules(db, RULES);
  return { sandbox, db };
}

async function rejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to reject');
}

function contextOf(error: Error): RtdbDenialContext {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'denialContext');
  expect(descriptor?.enumerable).toBe(true);
  return descriptor!.value as RtdbDenialContext;
}

function expectProductionShape(error: Error, code: string | undefined, message: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error.constructor.name).toBe('Error');
  expect(error.name).toBe('Error');
  expect(error.message).toBe(message);
  expect((error as { code?: unknown }).code).toBe(code);
}

function deniedOperation(events: SandboxEvent[], method: string): SandboxOperationEvent {
  const event = events.find((candidate): candidate is SandboxOperationEvent =>
    candidate.kind === 'operation' && candidate.service === 'rtdb'
    && candidate.method === method && candidate.result === 'deny');
  expect(event).toBeDefined();
  return event!;
}

const DENIED = 'PERMISSION_DENIED: Permission denied';
const LISTENER_DENIED = (path: string) =>
  `permission_denied at ${path}: Client doesn't have permission to access the desired data.`;

describe('RTDB sandbox denialContext', () => {
  it('get: carries the read rule that denied it', async () => {
    const { db } = setup();
    const error = await rejection(() => get(ref(db, 'rooms/bob')));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    const context = contextOf(error);
    expect(context).toMatchObject({
      engine: 'rtdb',
      auth: { uid: 'alice' },
      request: { method: 'get', path: '/rooms/bob' },
      matchedPath: '/rooms/$roomId',
      matchedRule: 'auth.uid == $roomId',
      pathVariableBindings: { $roomId: 'bob' },
    });
    expect(context.reasons.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });

  it('set: carries the write rule and the proposed value', async () => {
    const { db } = setup();
    const error = await rejection(() => set(ref(db, 'rooms/bob/name'), 'Bob'));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'set', path: '/rooms/bob/name', data: 'Bob' },
      matchedRule: 'auth.uid == $roomId',
      pathVariableBindings: { $roomId: 'bob' },
    });
  });

  it('set: a failed .validate names the validate rule', async () => {
    const { db } = setup();
    const error = await rejection(() => set(ref(db, 'rooms/alice/score'), 'high'));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'set', path: '/rooms/alice/score', data: 'high' },
      matchedRule: 'newData.isNumber()',
      rtdbTrace: expect.arrayContaining([
        expect.objectContaining({ kind: 'validate', conditionText: 'newData.isNumber()', verdict: 'DENY' }),
      ]),
    });
  });

  it('remove: reports the remove method', async () => {
    const { db } = setup();
    const error = await rejection(() => remove(ref(db, 'rooms/bob')));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error).request).toEqual({ method: 'remove', path: '/rooms/bob', data: null });
  });

  it('update: names the denied path of a multi-path update', async () => {
    const { db } = setup();
    const error = await rejection(() => update(ref(db, 'rooms'), { 'alice/name': 'A', 'bob/name': 'B' }));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'update', path: '/rooms/bob/name', data: 'B' },
      pathVariableBindings: { $roomId: 'bob' },
    });
  });

  it('setPriority: reports the setPriority method', async () => {
    const { db } = setup();
    const error = await rejection(() => setPriority(ref(db, 'rooms/bob'), 1));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    // The payload is the priority, as the operation event records it.
    expect(contextOf(error).request).toEqual({ method: 'setPriority', path: '/rooms/bob', data: 1 });
  });

  it('query get: carries the query spec the event records', async () => {
    const { db, sandbox } = setup();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((event) => events.push(event));
    const error = await rejection(() => get(query(ref(db, 'rooms/bob'), orderByKey(), limitToFirst(2))));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    const context = contextOf(error);
    const event = deniedOperation(events, 'get');
    expect(context.request.method).toBe('get');
    expect(context.request.query).toBeDefined();
    expect(context.request.query).toEqual(event.request?.query);
  });

  it('onDisconnect: a denied registration carries the context', async () => {
    const { db } = setup();
    const error = await rejection(() => onDisconnect(ref(db, 'rooms/bob/online')).set(false));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'onDisconnect', path: '/rooms/bob/online', data: false },
      matchedRule: 'auth.uid == $roomId',
      pathVariableBindings: { $roomId: 'bob' },
    });
  });

  it('the rule fields equal the denied operation event\'s rules block', async () => {
    const { db, sandbox } = setup();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((event) => events.push(event));
    const error = await rejection(() => set(ref(db, 'rooms/alice/score'), 'high'));
    const context = contextOf(error);
    const event = deniedOperation(events, 'set');
    const definedRules = JSON.parse(JSON.stringify(event.rules));
    const { auth: _auth, reasons, request, ...ruleFields } = context;
    expect(ruleFields).toEqual(definedRules);
    expect(reasons).toEqual(event.reasons!);
    expect(request.data).toEqual(event.request?.data);
  });

  it('runTransaction: keeps production\'s codeless error and carries the context', async () => {
    const { db, sandbox } = setup();
    const owner = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    await set(ref(owner, 'rooms/bob/count'), 1);
    rtdbSandbox.setRules(db, {
      rules: {
        rooms: {
          $roomId: { '.read': 'true', '.write': 'auth.uid == $roomId' },
        },
      },
    });
    const error = await rejection(() => runTransaction(ref(db, 'rooms/bob/count'), (n) => (n as number) + 1));
    expectProductionShape(error, undefined, 'permission_denied');
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'transaction', path: '/rooms/bob/count', data: 2 },
      matchedRule: 'auth.uid == $roomId',
    });
  });

  it('onValue: an initially denied listener cancels with the context', async () => {
    const { db } = setup();
    const error = await new Promise<Error>((resolve) => {
      onValue(ref(db, 'rooms/bob'), () => {}, resolve);
    });
    expectProductionShape(error, 'PERMISSION_DENIED', LISTENER_DENIED('/rooms/bob'));
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      request: { method: 'listen', path: '/rooms/bob' },
      matchedRule: 'auth.uid == $roomId',
    });
  });

  it('onChildAdded: an initially denied listener cancels with the context', async () => {
    const { db } = setup();
    const error = await new Promise<Error>((resolve) => {
      onChildAdded(ref(db, 'rooms/bob'), () => {}, resolve);
    });
    expectProductionShape(error, 'PERMISSION_DENIED', LISTENER_DENIED('/rooms/bob'));
    expect(contextOf(error).request).toEqual({ method: 'listen', path: '/rooms/bob' });
  });

  it('revoked listeners cancel with the context of the new rules', async () => {
    const { db } = setup();
    const errors: Error[] = [];
    onValue(ref(db, 'rooms/alice'), () => {}, (error) => errors.push(error));
    onChildAdded(ref(db, 'rooms/alice'), () => {}, (error) => errors.push(error));
    rtdbSandbox.setRules(db, { rules: { rooms: { '.read': 'false' } } });
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expectProductionShape(error, 'PERMISSION_DENIED', LISTENER_DENIED('/rooms/alice'));
      expect(contextOf(error)).toMatchObject({
        engine: 'rtdb',
        request: { method: 'listen', path: '/rooms/alice' },
      });
    }
  });

  it('no rules loaded under a deny policy: reports the default deny', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth(null));
    rtdbSandbox.setDefaultPolicy(db, 'deny');
    const error = await rejection(() => get(ref(db, 'anything')));
    expectProductionShape(error, 'PERMISSION_DENIED', DENIED);
    expect(contextOf(error)).toMatchObject({
      engine: 'rtdb',
      auth: null,
      request: { method: 'get', path: '/anything' },
      errorCode: 'NO_MATCHING_RULE',
      reasons: ['No RTDB rules loaded; default deny.'],
    });
  });
});
