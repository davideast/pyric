/**
 * The functions methods, judged against a planted RTDB trigger source: a
 * supported handler and one the runtime turns away with a reason.
 *
 * `fire` runs the supported handler on a synthetic event and is judged by the
 * handler's own return value, which the honesty test folds into the run's
 * logged result, and by the database it never touched: the path `fire` names
 * reads back absent afterward, because the whole point is a run that never
 * wrote.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { get, ref } from 'pyric/database';
import { databaseFor } from '../../../src/bridge/surface/service-handles.js';
import { ctx, finishHandlerSuite, projectDir, run } from './handler-harness.js';

const firebaseFunctionsPath = resolve(
  import.meta.dir,
  '../../../../conformance/node_modules/firebase-functions',
);

beforeAll(() => {
  mkdirSync(`${projectDir}/functions/node_modules`, { recursive: true });
  writeFileSync(`${projectDir}/firebase.json`, JSON.stringify({ functions: { source: 'functions' } }));
  writeFileSync(
    `${projectDir}/functions/package.json`,
    JSON.stringify({ name: 'handler-suite-functions', private: true, main: 'index.js' }),
  );
  writeFileSync(
    `${projectDir}/functions/index.js`,
    `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated('/messages/{pushId}/original', (event) => (
  event.data.val().toUpperCase()
));
exports.alwaysThrows = onValueCreated('/failures/{id}', () => {
  throw new Error('PYRIC_EXPECTED_FIRE_FAILURE');
});
exports.turnedOff = onValueCreated({ ref: '/messages/{id}', omit: true }, () => undefined);
exports.neverSettles = onValueCreated('/stuck/{id}', () => new Promise(() => {}));
`,
  );
  symlinkSync(firebaseFunctionsPath, `${projectDir}/functions/node_modules/firebase-functions`);
});

afterAll(() => finishHandlerSuite('functions'));

it('lists the supported handler and the one turned away with its reason', async () => {
  const listed = await run('functions.listTriggers');
  expect(listed.ok).toBe(true);
  const { triggers, unsupported } = listed.data as {
    triggers: Array<{ exportName: string; reference: string }>;
    unsupported: Array<{ exportName: string; eventType: string }>;
  };
  expect(triggers.map((trigger) => trigger.exportName)).toContain('makeUppercase');
  expect(unsupported).toContainEqual({
    exportName: 'turnedOff',
    eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
  });
});

it('runs the supported handler on a synthetic event and writes nothing to the database', async () => {
  const fired = await run('functions.fire', {
    trigger: 'makeUppercase',
    path: 'messages/abc123/original',
    value: 'hello',
  });
  expect(fired.ok).toBe(true);
  const { event, result } = fired.data as { event: { data: { delta: unknown } }; result: unknown };
  expect(event.data.delta).toBe('hello');
  // The handler's own computed return value, not the input echoed back: proof
  // the handler actually ran rather than the event merely being well-formed.
  expect(result).toBe('HELLO');

  const atPath = await get(ref(databaseFor(ctx), 'messages/abc123/original'));
  expect(atPath.exists()).toBe(false);
});

it('lists the fire as an execution, with cause and duration', async () => {
  const executions = await run('functions.executions');
  expect(executions.ok).toBe(true);
  const { executions: recorded } = executions.data as {
    executions: Array<{ trigger: string; cause: { ref: string }; durationMs: number; status: string }>;
  };
  const last = recorded.find((entry) => entry.trigger === 'makeUppercase')!;
  expect(last.cause.ref).toBe('messages/abc123/original');
  expect(last.status).toBe('fulfilled');
  expect(last.durationMs).toBeGreaterThanOrEqual(0);
});

it('reports a thrown handler as a rejected execution with its error', async () => {
  const fired = await run('functions.fire', {
    trigger: 'alwaysThrows',
    path: 'failures/one',
    value: true,
  });
  expect(fired.ok).toBe(false);
  expect(fired.summary).toContain('PYRIC_EXPECTED_FIRE_FAILURE');

  const executions = await run('functions.executions');
  const { executions: recorded } = executions.data as {
    executions: Array<{ trigger: string; status: string; error?: string }>;
  };
  const last = recorded.find((entry) => entry.trigger === 'alwaysThrows')!;
  expect(last.status).toBe('rejected');
  expect(last.error).toContain('PYRIC_EXPECTED_FIRE_FAILURE');
});

it('refuses an unknown trigger, naming listTriggers', async () => {
  const refused = await run('functions.fire', {
    trigger: 'doesNotExist',
    path: 'messages/x/original',
    value: 1,
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('listTriggers');
});

it('refuses a handler that never settles once timeoutMs elapses, logging it as timed out', async () => {
  const fired = await run('functions.fire', {
    trigger: 'neverSettles',
    path: 'stuck/one',
    value: true,
    timeoutMs: 50,
  });
  expect(fired.ok).toBe(false);
  expect(fired.summary).toContain('timed out');

  const executions = await run('functions.executions');
  const { executions: recorded } = executions.data as {
    executions: Array<{ trigger: string; status: string }>;
  };
  const last = recorded.find((entry) => entry.trigger === 'neverSettles')!;
  expect(last.status).toBe('timeout');
});
