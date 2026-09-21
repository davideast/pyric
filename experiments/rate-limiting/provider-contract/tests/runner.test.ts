import { test, expect } from 'bun:test';
import { runExperiment } from '../harness/runner.mjs';

test('a closed provider transport does not release capacity while independent provider work continues', async () => {
    const result = await runExperiment({ cases: ['transport-loss'] });
    expect(result.cases[0].status).toBe('complete');
    expect(result.cases[0].snapshots.afterFault.reservation.active).toBe(1);
    expect(result.cases[0].snapshots.afterFault.oracle.running).toBe(1);
    expect(result.cases[0].snapshots.afterFault.reservation.requests[0].state).toBe('unknown');
    expect(result.cases[0].snapshots.final.reservation.active).toBe(0);
    expect(result.cases[0].providerProcessId).not.toBe(result.cases[0].gatewayProcessId);
}, 15000);

test('the transport-only negative control admits overlapping work while the safe policy rejects it', async () => {
    const result = await runExperiment({ cases: ['unsafe-transport-release', 'unresolvable-budget'] });
    expect(result.cases[0].snapshots.final.oracle.running).toBe(2);
    expect(result.cases[0].capacityBoundRespected).toBe(false);
    expect(result.cases[1].snapshots.final.oracle.running).toBe(1);
    expect(result.cases[1].secondStart.status).toBe('budget-exhausted');
    expect(result.cases[1].snapshots.final.reservation.dispatches).toBe(1);
    expect(result.cases[1].observations.some(o => o.status === 'unsupported')).toBe(true);
}, 15000);

test('stop acknowledgments and actual gateway death preserve reservations until independently observable termination', async () => {
    const result = await runExperiment({ cases: ['explicit-stop', 'lost-gateway'] });
    const stop = result.cases[0];
    expect(stop.snapshots.afterFault.reservation.active).toBe(1);
    expect(stop.snapshots.afterFault.oracle.running).toBe(1);
    expect(stop.forgedStop.status).toBe('denied');
    expect(stop.snapshots.final.reservation.requests[0].state).toBe('cancelled');
    expect(stop.snapshots.final.reservation.releases).toBe(1);
    const crash = result.cases[1];
    expect(crash.replacementProcessId).not.toBe(crash.gatewayProcessId);
    expect(crash.snapshots.afterFault.oracle.running).toBe(1);
    expect(crash.snapshots.afterFault.reservation.active).toBe(1);
    expect(crash.snapshots.final.reservation.active).toBe(0);
}, 15000);

test('completion, interruption, unsupported lookup and both stop races have separate observable outcomes', async () => {
    const result = await runExperiment({ cases: ['normal-response', 'normal-stream', 'abort-before-dispatch', 'abort-after-acceptance', 'abort-after-chunk', 'gateway-deadline', 'complete-then-stop', 'stop-then-complete', 'duplicate-key', 'missing-lookup', 'inaccessible-lookup'] });
    expect(result.cases.every(row => row.status === 'complete')).toBe(true);
    expect(result.assertions.every(row => row.matched)).toBe(true);
    const byId = Object.fromEntries(result.cases.map(row => [row.caseId, row]));
    expect(byId['abort-before-dispatch'].snapshots.final.reservation.dispatches).toBe(0);
    expect(byId['abort-before-dispatch'].snapshots.final.oracle.attempts).toBe(0);
    expect(byId['normal-stream'].observations.some(o => o.status === 'chunk')).toBe(true);
    expect(byId['duplicate-key'].snapshots.final.oracle.jobs).toHaveLength(1);
    expect(byId['duplicate-key'].snapshots.final.oracle.attempts).toBe(2);
    expect(byId['missing-lookup'].snapshots.final.reservation.active).toBe(1);
    expect(byId['inaccessible-lookup'].snapshots.final.reservation.active).toBe(1);
}, 20000);
