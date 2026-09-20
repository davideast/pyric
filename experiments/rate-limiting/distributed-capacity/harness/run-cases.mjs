import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCluster } from '../adapters/pyric-cluster.mjs';
import { createProvider } from '../services/provider.mjs';
import { pyricBackend } from '../../../shared/backends/pyric.mjs';
import { scenarios } from './scenarios.mjs';
/** @param {string[]} ids @param {(event: any) => void} onEvent @param {string} runId */
export async function runCases(ids = Object.keys(scenarios), onEvent = (_event) => {}, runId = randomUUID()) {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !scenarios[id])) throw new Error('Unknown or duplicate case');
    const result = { schemaVersion: 2, run: { id: runId, selectedCases: ids, startedAt: new Date().toISOString(), environment: { ...pyricBackend.environment, transport: 'separate Node gateways; IPC to shared in-process Pyric native transactions', production: false, clock: 'shared logical milliseconds advanced at barriers, frozen per command',
        authorization: 'trusted synthetic gateway owners; public Admin sandbox API bypasses client Rules',
        limitations: ['No hosted Firestore measurement or pessimistic-locking/throughput claim', 'A single parent owns Pyric; gateway processes execute native transaction callbacks over IPC', 'Provider status and remote activity are a fixture, not real AI Logic confirmation', 'No autoscaling, clock-skew, automatic reaper, allowance charging or durable provider reconciliation service is validated'] } }, cases: [], events: [], assertions: [] };
    for (const id of ids) {
        const record = (kind, data = {}) => {
            const event = { ...data, kind, caseId: id, runId: result.run.id, sequence: result.events.length, timestamp: new Date().toISOString() };
            result.events.push(event); onEvent(event);
        };
        const check = (name, actual, expected, expectedPass = true) => result.assertions.push({ runId: result.run.id, caseId: id, name, actual, expected, passed: isDeepStrictEqual(actual, expected), expectedPass });
        const scenario = scenarios[id], provider = createProvider(record);
        const cluster = await createCluster({ record, provider, limits: scenario.limits, runId, caseId: id });
        try {
            const observations = await scenario.run({ cluster, provider, check, record });
            result.cases.push({ id, status: 'complete', observations, state: await cluster.snapshot(), oracle: provider.snapshot() });
        } catch (error) {
            result.cases.push({ id, status: 'incomplete', error: error.message, state: await cluster.snapshot(), oracle: provider.snapshot() });
        } finally { await cluster.close(); }
    }
    result.run.finishedAt = new Date().toISOString(); return result;
}
