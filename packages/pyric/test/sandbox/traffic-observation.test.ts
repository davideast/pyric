import { expect, test } from 'bun:test';
import { trafficOperationEvent, toOperationRecord } from '../../src/sandbox/operation-record.js';
import { observationPayload, observationText } from '../../src/sandbox/internal/observation-payload.js';

test('Auth changes use the common request projection with credential-free evidence', () => {
  const event = trafficOperationEvent({ kind: 'service_mutation', id: 'auth-event', at: Date.now(), service: 'auth',
    op: 'sign_in', path: 'synthetic-user', auth: { uid: 'synthetic-user' },
    after: { uid: 'synthetic-user', providerId: 'google.com', displayName: 'password="never-retain"', nested: { password: 'never-retain', accessToken: 'never-retain-either' } } });
  expect(event).not.toBeNull();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain('never-retain');
  expect(serialized).toContain('google.com');
  expect(toOperationRecord(event!)?.rules).toEqual({ kind: 'not-evaluated', reason: 'not-a-rules-operation' });
});

test('previews redact credential syntax and declare payload truncation', () => {
  expect(observationText('Authorization: Bearer private.value password="secret" apiKey=secret')).not.toContain('private.value');
  expect(observationText('password="secret" apiKey=secret')).not.toContain('secret');
  expect(observationPayload({ auth: { refreshToken: 'private' }, message: 'safe' })?.text).not.toContain('private');
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
