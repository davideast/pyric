import { expect, test } from 'bun:test';
import { trafficOperationEvent, toOperationRecord } from '../../src/sandbox/operation-record.js';
import { observationPayload } from '../../src/sandbox/internal/observation-payload.js';

test('Auth changes use the common request projection with verbatim bounded evidence and __proto__ quarantine', () => {
  const after = JSON.parse(
    '{"uid":"synthetic-user","providerId":"google.com","pageToken":"next-page-1","__proto__":{"toString":"not-callable"}}',
  ) as Record<string, unknown>;
  const event = trafficOperationEvent({
    kind: 'service_mutation',
    id: 'auth-event',
    at: Date.now(),
    service: 'auth',
    op: 'sign_in',
    path: 'synthetic-user',
    auth: { uid: 'synthetic-user' },
    after,
  });
  expect(event).not.toBeNull();
  const data = (event as { resourceAfter?: { data?: Record<string, unknown> } }).resourceAfter?.data;
  expect(data?.providerId).toBe('google.com');
  expect(data?.pageToken).toBe('next-page-1');
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(() => String(data)).not.toThrow();
  expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
  expect(toOperationRecord(event!)?.rules).toEqual({ kind: 'not-evaluated', reason: 'not-a-rules-operation' });
});

test('previews preserve JSON fields verbatim and declare payload truncation', () => {
  const preview = observationPayload({ auth: { pageToken: 'cursor-1' }, header: 'Authorization: Bearer sample' });
  expect(preview?.truncated).toBe(false);
  expect(preview?.text).toContain('cursor-1');
  expect(preview?.text).toContain('Bearer sample');
  expect(observationPayload('x'.repeat(20_000))).toMatchObject({ truncated: true });
  expect(observationPayload('x'.repeat(20_000))?.text.length).toBe(16384);
});

test('a new host marks an unfinished prior-session request interrupted without inventing an end time', async () => {
  const { initializeSandbox } = await import('../../src/sandbox/index.js');
  const { primeEventHistory } = await import('../../src/sandbox/internal/sandbox-impl.js');
  const sandbox = initializeSandbox();
  primeEventHistory(sandbox, [{ kind: 'operation', id: 'prior-start', at: Date.now(), service: 'ai',
    method: 'generateContentStream', auth: null, origin: 'user', result: 'not-applicable',
    observation: { id: 'prior-request', startedAt: Date.now(), status: 'pending' } }]);
  const record = toOperationRecord(sandbox.history()[0]!);
  expect(record?.observation?.status).toBe('interrupted');
  expect(record?.observation?.endedAt).toBeUndefined();
});
