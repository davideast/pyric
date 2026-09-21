import { randomUUID } from 'node:crypto';
import { aiLogicContract } from '../adapters/ai-logic.mjs';
import { durableBudget } from './budget.mjs';
import { caseIds, validateConfig } from './config.mjs';

// Public runner: the same provider transport and Firestore transaction policy run
// with a loopback HTTP fixture + Pyric, or explicit real credentials + Firestore.
export async function runLiveCases({ config, db, runId, apiKey, credentials, loopbackFixture = undefined, allowRealInference = false,
    journal = (_event) => {}, checkpoint = (_partial) => {} }) {
    validateConfig(config);
    if (!loopbackFixture && !allowRealInference) throw new Error('Real inference requires explicit opt-in');
    const events = [], cases = []; let sequence = 0; const started = performance.now();
    const record = (kind, fields = {}) => {
        const event = { schemaVersion: 1, experimentId: 'provider-contract', runId, caseId: null, requestId: null, attemptId: null, instanceId: `controller-${process.pid}`,
            timestamp: new Date().toISOString(), localSequence: ++sequence, localElapsedMs: performance.now() - started, ...fields, kind };
        events.push(event); journal(event);
    };
    const budget = durableBudget({ db, runId, limits: config.limits, record });
    await budget.initialize();
    for (const caseId of caseIds) {
        const attemptId = randomUUID(), observations = [], controller = new AbortController();
        const before = await budget.snapshot();
        let abortIssued = false, finalMarkerAtAbort = null, outcome = 'complete';
        const metadata = { caseId, requestId: 'request-one', attemptId };
        record('case-start', metadata);
        if (caseId === 'abort-before-dispatch') controller.abort();
        const remainingMs = before.deadlineAt - Date.now();
        if (remainingMs <= 0 && caseId !== 'abort-before-dispatch') { cases.push({ caseId, status: 'unexecuted', reason: 'run-deadline', remoteState: 'unknown' }); continue; }
        const adapter = aiLogicContract({ ...config, apiKey, credentials, loopbackFixture, allowRealInference,
            maxOutputTokens: config.limits.maxOutputTokens, timeoutMs: Math.max(1, Math.min(config.limits.requestDeadlineMs, remainingMs)),
            reserveDispatch: () => budget.reserve(caseId, attemptId),
            emit: async observation => {
                observations.push(observation); record('provider-observation', { ...metadata, ...observation });
                if (caseId === 'abort-after-chunk' && observation.status === 'chunk' && !abortIssued) {
                    abortIssued = true; finalMarkerAtAbort = observation.finalMarker; record('client-abort-requested', { ...metadata, finalMarkerAtAbort }); controller.abort();
                }
                await budget.settle(caseId, attemptId, observation);
            },
        });
        try {
            const handle = await adapter.start({ prompt: 'List the integers from one through forty, separated by spaces. Output only the list.', streaming: ['normal-stream', 'abort-after-chunk'].includes(caseId), signal: controller.signal });
            await handle.completion;
        } catch (error) {
            outcome = 'incomplete'; record('case-failure', { ...metadata, code: error.message === 'dispatch-budget-exhausted' ? 'budget-exhausted' : 'credential-transport-or-settlement-failure' });
        }
        const after = await budget.snapshot();
        const completed = observations.some(o => o.status === 'completed' && o.strength === 'authoritative-terminal');
        const expectedObserved = caseId === 'abort-before-dispatch' ? after.dispatches === before.dispatches
            : caseId === 'abort-after-chunk' ? abortIssued && finalMarkerAtAbort === false && !completed && after.active === before.active + 1 : completed;
        cases.push({ caseId, status: outcome === 'complete' && expectedObserved ? 'complete' : 'inconclusive', expectedObserved,
            dispatches: after.dispatches - before.dispatches, remoteState: completed ? 'completed' : caseId === 'abort-before-dispatch' ? 'not-dispatched' : 'unknown',
            abortIssued, finalMarkerAtAbort, observations, snapshots: { before, after }, oracle: null });
        record('case-settled', { ...metadata, status: cases.at(-1).status });
        checkpoint({ cases, events, finalBudget: after });
    }
    return { schemaVersion: 1, run: { id: runId, selectedCases: caseIds, realInference: !loopbackFixture }, cases, events, finalBudget: await budget.snapshot() };
}
