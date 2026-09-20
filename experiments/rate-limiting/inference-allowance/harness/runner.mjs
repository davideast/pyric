import { createStore, environment } from '../adapters/pyric-store.mjs';
import { createGateway } from '../architecture/gateway.mjs';
import { fakeInference } from '../services/fake-inference.mjs';
import policies from '../fixtures/policies.json' with { type: 'json' };
import workload from '../fixtures/workloads.json' with { type: 'json' };
import { controlledClock } from './clock.mjs';
import { createRecorder } from './recorder.mjs';
import { accounting } from '../scenarios/accounting.mjs';
import { contention } from '../scenarios/contention.mjs';
import { recovery } from '../scenarios/recovery.mjs';
import { authorization } from '../scenarios/authorization.mjs';
import { overload } from '../scenarios/overload.mjs';
export const scenarios = { ...accounting, ...contention, ...recovery, ...authorization, ...overload };
export async function runExperiment({ cases = Object.keys(scenarios), storeFactory = createStore, backendEnvironment = environment, runId, onEvent, fault, limits = { maxRequests: 500 } } = {}) {
    if (!Number.isInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 500)
        throw new Error('maxRequests must be an integer from 1 to 500');
    let requestsStarted = 0;
    for (const id of cases)
        if (!scenarios[id])
            throw new Error(`Unknown case: ${id}`);
    if (new Set(cases).size !== cases.length || !cases.length)
        throw new Error('Cases must be nonempty and unique');
    const { result, forCase } = createRecorder(backendEnvironment, runId, onEvent);
    result.run.workload = { ...workload, limits };
    result.run.limits = limits;
    result.run.policies = policies;
    result.run.selectedCases = cases;
    for (const caseId of cases) {
        const scenario = scenarios[caseId];
        const row = { id: caseId, status: 'running' };
        result.cases.push(row);
        if (scenario.requires?.some(cap => !backendEnvironment.capabilities?.[cap])) {
            row.status = 'unsupported';
            row.error = 'Required backend capability is unavailable';
            continue;
        }
        const { record, assert: check } = forCase(caseId);
        const events = [];
        const recordCase = (kind, data) => { events.push({ kind, ...data }); return record(kind, data); };
        let store, gateway, secondGateway;
        try {
            store = await storeFactory({ record: recordCase, fault: fault ?? scenario.fault?.(), maxAttempts: scenario.maxAttempts ?? workload.maxAttempts, caseId, runId: result.run.id });
            const clock = controlledClock(workload.clockStart);
            const setup = scenario.setup?.() ?? {};
            const gatewayOptions = { store, authenticate: setup.authenticate ?? (async (token) => ['alice', 'bob', 'carol'].find(u => `${u}-token` === token) ?? null), inference: fakeInference(recordCase, scenario.inference), policies, clock, record: recordCase, ...scenario.options };
            gateway = createGateway(gatewayOptions);
            secondGateway = createGateway({ ...gatewayOptions, instanceId: 'local-2' });
            let requestNumber = 0;
            const dispatch = (target, uid = 'alice', route = 'chat', body = {}) => {
                if (requestsStarted >= limits.maxRequests) {
                    recordCase('request-budget-exhausted', { maxRequests: limits.maxRequests, requestsStarted });
                    throw new Error('run_request_budget_exhausted');
                }
                requestsStarted++;
                return target.request({ token: `${uid}-token`, route, body: { requestId: `request-${requestNumber++}`, model: 'test-model', prompt: 'hello', ...body } });
            };
            const send = (...args) => dispatch(gateway, ...args);
            const secondSend = (...args) => dispatch(secondGateway, ...args);
            await scenario.run({ ...setup, send, secondSend, gateway, secondGateway, check, store, clock, events, record: recordCase });
            row.status = 'complete';
        }
        catch (error) {
            row.status = 'error';
            row.error = String(error);
        }
        finally {
            if (gateway)
                await gateway.drain();
            if (secondGateway)
                await secondGateway.drain();
            if (store)
                await store.close();
        }
    }
    result.run.finishedAt = new Date().toISOString();
    result.requests = result.events.filter(e => e.kind === 'request-start' || e.kind === 'request-response');
    result.transactions = result.events.filter(e => e.kind.startsWith('transaction-'));
    result.admissions = result.events.filter(e => e.kind === 'admission-decision');
    result.observations = result.events.filter(e => ['outstanding', 'arrival', 'contention-observation', 'request-budget-exhausted'].includes(e.kind));
    return result;
}
