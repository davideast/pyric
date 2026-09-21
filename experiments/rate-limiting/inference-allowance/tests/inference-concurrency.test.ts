import { expect, test } from 'bun:test';
import { runHttpExperiment } from '../harness/http-runner.mjs';

test('execution capacity rejects before allowance work while slow inference holds its slot', async () => {
    const result = await runHttpExperiment({ cases: ['execution-user-guard'] });
    expect(result.cases).toEqual([{ id: 'execution-user-guard', status: 'complete' }]);
    expect(result.run.workload.inference).toBe('scenario-configured observable fake provider; no real inference');
    const replies = result.events.filter(e => e.kind === 'client-response');
    expect(replies.find(e => e.clientAttemptId === 'retry')).toMatchObject({ status: 'execution_busy', httpStatus: 503 });
    expect(replies.find(e => e.clientAttemptId === 'recovered')).toMatchObject({ status: 'completed' });
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 10000);

test('an inference timeout requests cancellation but retains execution capacity until the provider settles', async () => {
    const result = await runHttpExperiment({ cases: ['execution-timeout-ignored'] });
    expect(result.cases[0].status).toBe('complete');
    expect(result.assertions.find(a => a.name === 'inference deadline observed')).toMatchObject({ passed: true });
    const responses = result.events.filter(e => e.kind === 'client-response');
    expect(responses.find(e => e.clientAttemptId === 'held')).toMatchObject({ status: 'inference_timeout', httpStatus: 504 });
    expect(responses.find(e => e.clientAttemptId === 'retry')).toMatchObject({ status: 'execution_busy' });
    expect(responses.find(e => e.clientAttemptId === 'recovered')).toMatchObject({ status: 'completed' });
    const server = result.events.filter(e => e.role === 'server');
    const cancel = server.find(e => e.kind === 'provider-cancel-requested' && e.requestId === 'held');
    const settled = server.find(e => e.kind === 'provider-settled' && e.requestId === 'held');
    expect(cancel).toBeDefined();
    expect(settled.localSequence).toBeGreaterThan(cancel.localSequence);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 10000);

test('streaming and disconnected clients retain execution capacity through provider settlement', async () => {
    const result = await runHttpExperiment({ cases: ['execution-stream', 'execution-disconnect-ignored', 'execution-cancel-confirmed'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    for (const id of result.run.selectedCases) {
        const events = result.events.filter(e => e.caseId === id);
        const retry = events.find(e => e.kind === 'client-response' && e.clientAttemptId === 'retry');
        expect(retry).toMatchObject({ status: 'execution_busy' });
        expect(events.find(e => e.kind === 'client-response' && e.clientAttemptId === 'recovered')).toMatchObject({ status: 'completed' });
        expect(events.some(e => e.kind === 'client-chunk' && e.clientAttemptId === 'held')).toBe(true);
        expect(events.some(e => e.kind === 'client-chunk-acknowledged' && e.clientAttemptId === 'held')).toBe(true);
        for (const event of events.filter(e => e.kind === 'inference-dispatch')) {
            expect(event.attemptId).toBeString();
            expect(event.instanceId).toBeString();
        }
    }
    expect(result.events.filter(e => e.kind === 'client-disconnected')).toHaveLength(2);
    expect(result.events.filter(e => e.kind === 'provider-cancel-confirmed')).toHaveLength(1);
    expect(result.assertions.every(a => a.passed)).toBe(true);
}, 15000);

test('negative control exposes unbounded execution, while instance and sustained guards bound work and recover from errors', async () => {
    const result = await runHttpExperiment({ cases: ['execution-admission-only', 'execution-instance-guard', 'execution-sustained', 'execution-provider-error'] });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    const control = result.assertions.find(a => a.caseId === 'execution-admission-only' && a.name === 'execution capacity bound');
    expect(control).toMatchObject({ passed: false, expectedPass: false });
    const instance = result.events.filter(e => e.caseId === 'execution-instance-guard' && e.kind === 'client-response');
    expect(result.assertions.find(a => a.name === 'execution instance saturation')).toMatchObject({ passed: true });
    expect(instance.filter(e => e.status === 'completed')).toHaveLength(2);
    expect(instance.filter(e => e.status === 'execution_busy')).toHaveLength(4);
    const sustained = result.events.filter(e => e.caseId === 'execution-sustained' && e.kind === 'client-response');
    expect(sustained.filter(e => ['bob','carol'].includes(e.uid) && e.status === 'completed')).toHaveLength(6);
    const failed = result.events.filter(e => e.caseId === 'execution-provider-error');
    expect(failed.find(e => e.kind === 'client-response' && e.clientAttemptId === 'held')).toMatchObject({ status: 'outcome_unknown' });
    expect(failed.filter(e => e.kind === 'inference-dispatch' && e.requestId === 'held')).toHaveLength(1);
    expect(failed.find(e => e.kind === 'client-response' && e.clientAttemptId === 'recovered')).toMatchObject({ status: 'completed' });
    expect(result.assertions.every(a => a.passed === a.expectedPass)).toBe(true);
}, 15000);

test('execution capture preserves the expected negative control, provider lifetime measurements and replay', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { captureRun, verifyCapture } = await import('../../../shared/evidence/capture.mjs');
    const { captureDefinition } = await import('../capture-definition.mjs');
    const { compareRuns } = await import('../analysis/assess.mjs');
    const output = await mkdtemp(join(tmpdir(), 'execution-capture-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: {
            profile:'local', suite:'http-overload', cases:['execution-admission-only','execution-timeout-ignored'], limits:{maxRequests:10},
        } });
        expect(saved.successfulExperiment).toBe(true);
        expect(saved.expectedNegativeControls).toBe(1);
        expect((await verifyCapture(saved.directory)).valid).toBe(true);
        const { readdir } = await import('node:fs/promises');
        const capturedFiles = await readdir(saved.directory, { recursive:true });
        expect(capturedFiles.some(p => p.endsWith('INFERENCE-CONCURRENCY.md'))).toBe(true);
        const result = JSON.parse(await readFile(join(saved.directory, 'result.json'), 'utf8'));
        const summary = JSON.parse(await readFile(join(saved.directory, 'summary.json'), 'utf8'));
        expect(summary.http['execution-admission-only'].execution.peakActiveProviderCalls).toBe(6);
        expect(summary.http['execution-timeout-ignored'].execution.cancellationRequests).toBe(1);
        expect(summary.http['execution-timeout-ignored'].execution.cancellationConfirmations).toBe(0);
        expect(summary.http['execution-timeout-ignored'].execution.settlementAfterResponse.maxMs).toBeGreaterThan(300);
        const replay = await captureRun(output, {sourceCapture:saved.directory});
        expect(replay.successfulExperiment).toBe(true);
        const replayResult = JSON.parse(await readFile(join(replay.directory,'result.json'),'utf8'));
        expect(compareRuns(result,replayResult).compatible).toBe(true);
    } finally { await rm(output,{recursive:true,force:true}); }
}, 20000);
