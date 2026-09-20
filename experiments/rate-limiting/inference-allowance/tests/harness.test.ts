import { expect, test } from 'bun:test';
import { runExperiment } from '../harness/runner.mjs';
test('a fifty-request burst cannot spend more than five admissions', async () => {
    const result = await runExperiment({ cases: ['burst-50'] });
    expect(result.cases[0].status).toBe('complete');
    const check = result.assertions.find(a => a.name === 'five admissions');
    expect(check.actual).toBe(5);
    expect(check.passed).toBe(true);
    expect(result.assertions.every(a => a.passed)).toBe(true);
    expect(result.inferences.length).toBe(5);
});
test('retains an overspending control and checks refill, category isolation and duplicate requests', async () => {
    const result = await runExperiment({ cases: ['unsafe-burst', 'refill', 'isolation', 'duplicates'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    expect(result.assertions.find(a => a.caseId === 'unsafe-burst' && a.name === 'allowance respected')?.passed).toBe(false);
    expect(result.assertions.filter(a => a.caseId !== 'unsafe-burst').every(a => a.passed)).toBe(true);
    expect(result.assertions.filter(a => a.caseId === 'duplicates').length).toBeGreaterThanOrEqual(3);
});
test('fails closed across malformed state, authentication failures and uncertain commits', async () => {
    const result = await runExperiment({ cases: ['authorization', 'malformed', 'before-commit-failure', 'commit-ack-lost', 'dispatch-ack-lost', 'admission-timeout', 'provider-failure'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    expect(result.assertions.length).toBeGreaterThanOrEqual(20);
    expect(result.assertions.filter(a => !a.passed)).toEqual([]);
});
test('measures multiple gateways and normal users during a flood without assuming production latency', async () => {
    const result = await runExperiment({ cases: ['multi-gateway', 'flood', 'guarded-flood', 'retry-exhaustion'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    expect(result.assertions.filter(a => !a.passed)).toEqual([]);
    expect(result.events.some(e => e.kind === 'request-response' && e.status === 'admission_busy')).toBe(true);
});
test('null bucket corruption fails closed rather than silently replenishing allowance', async () => {
    const result = await runExperiment({ cases: ['malformed'] });
    expect(result.assertions.find(a => a.name === 'null bucket denied')?.passed).toBe(true);
});
import { createGateway } from '../architecture/gateway.mjs';
import { createStore } from '../adapters/pyric-store.mjs';
import { fakeInference } from '../services/fake-inference.mjs';
import policies from '../fixtures/policies.json';
test('a stalled authenticator times out before it is released and cannot dispatch later', async () => {
    const events = [];
    const record = (kind, data) => events.push({ kind, ...data });
    let release;
    const identity = new Promise<string>(resolve => { release = resolve; });
    const store = await createStore({ record });
    const gateway = createGateway({ store, record, authenticate: () => identity, inference: fakeInference(record), policies, clock: { now: () => 1000000 }, deadlineMs: 5 });
    const request = gateway.request({ token: 'alice-token', route: 'chat', body: { requestId: 'auth', model: 'test-model', prompt: 'hello' } });
    const observed = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve({ status: 'still_waiting' }), 50))]);
    release('alice');
    await gateway.drain();
    await request;
    await store.close();
    expect(observed).toMatchObject({ status: 'admission_timeout' });
    expect(events.some(e => e.kind === 'inference-dispatch')).toBe(false);
});
test('portable contention checks safety separately from observed retry and availability outcomes', async () => {
    const result = await runExperiment({ cases: ['portable-burst'] });
    expect(result.cases[0].status).toBe('complete');
    expect(result.assertions.filter(a => !a.passed)).toEqual([]);
    const observed = result.events.find(e => e.kind === 'contention-observation');
    expect(observed.users.alice).toMatchObject({ requests: 50, completed: 5, quotaExhausted: 45, dispatches: 5, charged: 5 });
    expect(observed.users.bob).toMatchObject({ requests: 5, completed: 5, dispatches: 5, charged: 5 });
    expect(observed.transactionAttempts).toBeGreaterThan(0);
});
test('a run request ceiling stops new admissions and retains incomplete evidence', async () => {
    const result = await runExperiment({ cases: ['portable-burst'], limits: { maxRequests: 3 } });
    expect(result.cases[0].status).toBe('error');
    expect(result.events.filter(e => e.kind === 'request-start')).toHaveLength(3);
    expect(result.inferences.length).toBeLessThanOrEqual(3);
    expect(result.run.limits.maxRequests).toBe(3);
});
