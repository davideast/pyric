import { expect, test } from 'bun:test';
import { runHttpExperiment } from '../harness/http-runner.mjs';

test('only the request owner can explicitly cancel; acknowledgement retains capacity until confirmed termination', async () => {
    const result = await runHttpExperiment({ suite: 'provider-lifecycle', cases: ['lifecycle-owner-cancel'] });
    expect(result.cases).toEqual([{ id: 'lifecycle-owner-cancel', status: 'complete' }]);
    const reply = (id: string) => result.events.find(e => e.kind === 'client-response' && e.clientAttemptId === id);
    expect(reply('foreign')).toMatchObject({ status: 'not_found', httpStatus: 404 });
    expect(reply('signed-out')).toMatchObject({ status: 'unauthenticated', httpStatus: 401 });
    expect(reply('forged')).toMatchObject({ status: 'invalid_request', httpStatus: 400 });
    expect(reply('cancel')).toMatchObject({ status: 'cancellation_requested', httpStatus: 202 });
    expect(reply('cancel-again')).toMatchObject({ status: 'cancellation_requested', httpStatus: 202 });
    expect(reply('retry')).toMatchObject({ status: 'execution_busy' });
    expect(reply('repeat')).toMatchObject({ status: 'duplicate' });
    expect(reply('recovered')).toMatchObject({ status: 'completed' });
    expect(result.events.filter(e => e.kind === 'provider-cancel-confirmed')).toHaveLength(1);
    expect(result.assertions.length).toBeGreaterThan(5);
    expect(result.assertions.filter(a => a.passed !== a.expectedPass)).toEqual([]);
}, 10000);

test('transport termination with an unknown remote outcome quarantines capacity without redispatch or refund', async () => {
    const result = await runHttpExperiment({ suite: 'provider-lifecycle', cases: ['lifecycle-unknown'] });
    expect(result.cases[0]).toMatchObject({ status: 'complete' });
    const reply = (id: string) => result.events.find(e => e.kind === 'client-response' && e.clientAttemptId === id);
    expect(reply('held')).toMatchObject({ status: 'outcome_unknown' });
    expect(reply('retry')).toMatchObject({ status: 'execution_busy' });
    expect(reply('later')).toMatchObject({ status: 'execution_busy' });
    expect(reply('other')).toMatchObject({ status: 'completed' });
    expect(result.events.filter(e => e.kind === 'inference-dispatch' && e.uid === 'alice')).toHaveLength(1);
    expect(result.events.filter(e => e.kind === 'execution-quarantined')).toHaveLength(1);
    expect(result.events.some(e => e.kind === 'provider-outcome' && e.requestId === 'held' && e.outcome === 'unknown')).toBe(true);
    expect(result.assertions.filter(a => a.passed !== a.expectedPass)).toEqual([]);
}, 10000);

test('completion, explicit stop, deadlines, disconnects and truncated streams have distinct observable outcomes', async () => {
    const cases = ['lifecycle-normal-stream', 'lifecycle-cancel-ignored', 'lifecycle-deadline',
        'lifecycle-disconnect', 'lifecycle-completion-race', 'lifecycle-before-dispatch', 'lifecycle-truncated-stream', 'lifecycle-transport-control'];
    const result = await runHttpExperiment({ suite: 'provider-lifecycle', cases });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    expect(result.assertions.filter(a => a.passed !== a.expectedPass)).toEqual([]);
    expect(result.assertions.filter(a => !a.expectedPass).length).toBeGreaterThan(0);
    const ordered = result.events.filter(e => e.caseId === 'lifecycle-cancel-ignored');
    const ended = ordered.find(e => e.kind === 'transport-ended' && e.requestId === 'held');
    const released = ordered.find(e => e.kind === 'execution-reservation' && e.action === 'release' && e.requestId === 'held');
    const confirmed = ordered.find(e => e.kind === 'provider-outcome' && e.requestId === 'held');
    expect(ended.localSequence).toBeLessThan(confirmed.localSequence);
    expect(confirmed.outcome).toBe('completed');
    expect(released.localSequence).toBeGreaterThan(confirmed.localSequence);
    expect(result.events.some(e => e.caseId === 'lifecycle-before-dispatch' && e.kind === 'inference-dispatch' && e.requestId === 'held')).toBe(false);
}, 20000);

test('lifecycle captures preserve unknown outcomes, the failing control, source and replayable comparisons', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { captureRun, verifyCapture } = await import('../../../shared/evidence/capture.mjs');
    const { captureDefinition } = await import('../capture-definition.mjs');
    const { compareRuns } = await import('../analysis/assess.mjs');
    const output = await mkdtemp(join(tmpdir(), 'provider-lifecycle-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: {
            profile: 'local', suite: 'provider-lifecycle', cases: ['lifecycle-unknown', 'lifecycle-transport-control'], limits: { maxRequests: 10 },
        } });
        expect(saved.successfulExperiment).toBe(true);
        expect(saved.expectedNegativeControls).toBe(2);
        expect((await verifyCapture(saved.directory)).valid).toBe(true);
        const json = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
        const original = await json(saved.directory, 'result.json');
        const summary = await json(saved.directory, 'summary.json');
        expect(summary.lifecycle['lifecycle-unknown']).toMatchObject({ unknown: 1, quarantined: 1 });
        expect(summary.lifecycle['lifecycle-transport-control'].peakRemotePerUser).toBe(2);
        const replay = await captureRun(output, { sourceCapture: saved.directory });
        expect(replay.successfulExperiment).toBe(true);
        expect(compareRuns(original, await json(replay.directory, 'result.json')).compatible).toBe(true);
    } finally { await rm(output, { recursive: true, force: true }); }
}, 20000);

test('provider confirmation releases capacity independently of a pending or resolved transport', async () => {
    const cases = ['lifecycle-confirmed-pending', 'lifecycle-confirmed-resolved', 'lifecycle-confirmed-rejected', 'lifecycle-completed-pending'];
    const result = await runHttpExperiment({ suite: 'provider-lifecycle', cases });
    expect(result.cases.every(c => c.status === 'complete')).toBe(true);
    expect(result.assertions.filter(a => a.passed !== a.expectedPass)).toEqual([]);
    for (const caseId of cases) {
        const events = result.events.filter(e => e.caseId === caseId);
        const response = events.find(e => e.kind === 'client-response' && e.clientAttemptId === 'held');
        expect(response.status).toBe(caseId === 'lifecycle-completed-pending' ? 'inference_timeout' : 'provider_cancelled');
        expect(events.find(e => e.kind === 'client-response' && e.clientAttemptId === 'recovered').status).toBe('completed');
    }
}, 10000);
