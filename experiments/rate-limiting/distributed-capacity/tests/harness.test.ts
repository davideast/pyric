import { test, expect } from 'bun:test';
import { runCases } from '../harness/run-cases.mjs';

test('three gateway processes share global and per-user execution capacity', async () => {
    const result = await runCases(['concurrent']);
    expect(result.cases[0].status).toBe('complete');
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    const state = result.cases[0].observations;
    expect(state.admitted).toBe(3);
    expect(state.peakRemote).toBe(3);
    expect(state.peakPerUser).toBeLessThanOrEqual(2);
    expect(new Set(result.events.filter(event => event.kind === 'gateway-ready').map(event => event.processId)).size).toBe(3);
}, 15000);

test('a crashed owner can be replaced before dispatch without duplicating its reservation', async () => {
    const result = await runCases(['crash-before-dispatch']);
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    expect(result.cases[0].observations.recoveredFence).toBe(2);
    expect(result.cases[0].observations.providerStarts).toBe(1);
    expect(result.cases[0].observations.finalActive).toBe(0);
});

test('recovery retains remote work and ambiguity, but releases a confirmed completion exactly once', async () => {
    const result = await runCases(['crash-during-inference', 'completion-before-record', 'dispatch-uncertain']);
    expect(result.cases.map(row => row.status)).toEqual(['complete', 'complete', 'complete']);
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    expect(result.cases[0].observations.busyWhileOrphaned).toBe('busy');
    expect(result.cases[1].observations.finalActive).toBe(0);
    expect(result.cases[2].observations.state).toBe('unknown');
    expect(result.cases[2].observations.finalActive).toBe(1);
});

test('lease renewal and takeover fence stale gateway mutations', async () => {
    const result = await runCases(['stale-owner', 'lease-renewal']);
    expect(result.cases.map(row => row.status)).toEqual(['complete', 'complete']);
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    expect(result.cases[0].observations.errors).toEqual(['stale-owner', 'stale-owner', 'stale-owner']);
    expect(result.cases[1].observations.takeoverError).toBe('lease-owned');
});

test('the unsafe lease-expiry control exposes global and per-user oversubscription', async () => {
    const result = await runCases(['unsafe-expiry']);
    expect(result.cases[0].status).toBe('complete');
    expect(result.cases[0].observations.peakRemote).toBe(2);
    expect(result.assertions.filter(check => !check.passed).map(check => check.name)).toEqual(['global bound', 'user bound']);
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
});

test('an acknowledged database commit survives a lost gateway acknowledgement and is not reserved twice', async () => {
    const result = await runCases(['commit-ack-lost']);
    expect(result.cases[0].status).toBe('complete');
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    expect(result.cases[0].observations.retryStatus).toBe('duplicate');
    expect(result.cases[0].observations.finalActive).toBe(1);
});

test('concurrent recovery elects one owner and hidden provider outcomes remain quarantined', async () => {
    const result = await runCases(['recovery-race', 'provider-unobservable', 'confirmed-cancellation', 'duplicate-admission']);
    expect(result.cases.every(row => row.status === 'complete')).toBe(true);
    expect(result.assertions.every(check => check.passed === check.expectedPass)).toBe(true);
    expect(result.cases[0].observations.winners).toBe(1);
    expect(result.cases[1].observations.unknownActive).toBe(1);
    expect(result.cases[2].observations.finalActive).toBe(0);
    expect(result.cases[3].observations.providerStarts).toBe(1);
    expect(result.cases[3].oracle.startAttempts).toBe(1);
});

test('malformed data fails closed and clients cannot edit the capacity ledger', async () => {
    const result = await runCases(['invalid-state']);
    expect(result.cases[0].status).toBe('complete');
    expect(result.assertions.filter(check => !check.passed)).toEqual([]);
});

test('a write evidence failure rejects the transaction and completes gateway cleanup', async () => {
    let injected = false;
    const result = await Promise.race([
        runCases(['concurrent'], event => {
            if (event.kind === 'transaction-write-staged' && !injected) {
                injected = true;
                throw new Error('evidence-write-failed');
            }
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cleanup hung')), 3000)),
    ]);
    expect(injected).toBe(true);
    expect(result.cases[0].status).toBe('incomplete');
    expect(result.cases[0].error).toBe('evidence-write-failed');
}, 5000);
