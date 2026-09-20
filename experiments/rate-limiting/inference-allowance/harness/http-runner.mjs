import { httpSuite } from '../scenarios/http-suites.mjs';
import { assessLifecycle } from '../analysis/provider-lifecycle.mjs';
import { assessExecution } from '../analysis/execution-checks.mjs';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRecorder } from './recorder.mjs';
import { environment } from '../adapters/pyric-store.mjs';
import policies from '../fixtures/policies.json' with { type: 'json' };
function nodeExecutable() {
    if (!process.versions.bun)
        return process.execPath;
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { }
    }
    throw new Error('Node executable unavailable (ENOENT)');
}
function child(path, record) {
    const childProcess = fork(fileURLToPath(new URL(path, import.meta.url)), [], { execPath: nodeExecutable(), silent: true });
    const messages = [];
    const waiters = new Map();
    let failure, stderr = '';
    childProcess.stderr.on('data', text => { stderr = (stderr + text).slice(-4000); });
    childProcess.stdout.resume();
    const fail = error => {
        failure = error;
        for (const waiter of waiters.values())
            waiter.reject(error);
        waiters.clear();
    };
    childProcess.on('error', fail);
    childProcess.on('message', message => {
        if (message.type === 'event')
            return record(message.kind, message.data);
        messages.push(message);
        const waiter = waiters.get(message.type);
        if (waiter) {
            waiters.delete(message.type);
            waiter.resolve(message);
        }
    });
    const exited = new Promise(resolve => childProcess.on('close', (code, signal) => {
        if (code !== 0)
            fail(new Error(`HTTP child failed (${code ?? signal}): ${stderr}`));
        else if (waiters.size)
            fail(new Error('HTTP child exited before expected message'));
        resolve();
    }));
    return {
        send(message) {
            try {
                childProcess.send(message, error => { if (error)
                    fail(error); });
            }
            catch (error) {
                fail(error);
            }
        },
        wait(type) {
            const saved = messages.find(m => m.type === type);
            if (saved)
                return Promise.resolve(saved);
            if (failure)
                return Promise.reject(failure);
            return new Promise((resolve, reject) => waiters.set(type, { resolve, reject }));
        },
        async close() { if (childProcess.exitCode === null && childProcess.signalCode === null)
            childProcess.kill('SIGKILL'); await exited; },
    };
}
export async function runHttpExperiment({ suite = 'http-overload', cases = Object.keys(httpSuite(suite).scenarios), runId, onEvent, limits = { maxRequests: 500 } } = {}) {
    const { scenarios: registry, workload } = httpSuite(suite);
    if (!cases.length || new Set(cases).size !== cases.length || cases.some(id => !registry[id]))
        throw new Error('Invalid HTTP cases');
    const count = cases.reduce((sum, id) => sum + registry[id].schedule.length, 0);
    if (!Number.isInteger(limits.maxRequests) || limits.maxRequests < count || limits.maxRequests > 500)
        throw new Error('HTTP workload exceeds request budget');
    const { result, forCase } = createRecorder({ ...environment, transport: 'loopback HTTP; in-process Pyric inside Node server',
        controllerRuntime: process.versions.bun ? 'bun' : 'node', controllerPid: process.pid }, runId, onEvent);
    Object.assign(result.run, { suite, selectedCases: cases, limits, policies,
        workload: { ...workload, limits, scenarios: Object.fromEntries(cases.map(id => [id, registry[id]])) } });
    if (cases.some(id => registry[id].execution))
        result.run.workload.inference = 'scenario-configured observable fake provider; no real inference';
    for (const id of cases) {
        const row = { id, status: 'running' };
        result.cases.push(row);
        const { record, assert: check } = forCase(id);
        const events = [];
        const recordCase = (kind, data = {}) => { events.push({ kind, ...data }); record(kind, data); };
        let server, generator, timer;
        try {
            const scenario = registry[id];
            const operation = (async () => {
                server = child('../services/http-server.mjs', recordCase);
                const ready = server.wait('ready');
                server.send({ scenario });
                const { port } = await ready;
                generator = child('./http-load-generator.mjs', recordCase);
                const generated = generator.wait('done');
                generator.send({ port, schedule: scenario.schedule });
                await generated;
                const drained = server.wait('done');
                server.send({ type: 'stop' });
                await drained;
            })();
            await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP case deadline exceeded')), workload.caseTimeoutMs); })]);
            check('all scheduled requests observed', events.filter(e => ['client-response', 'client-disconnected', 'client-error'].includes(e.kind)).length, scenario.schedule.length);
            const protocol = { completed: 200, provider_cancelled: 200, cancellation_requested: 202, not_found: 404, execution_busy: 503, inference_timeout: 504, client_cancelled: 499, quota_exhausted: 429, admission_busy: 503, admission_timeout: 504,
                unauthenticated: 401, invalid_request: 400, duplicate: 200, conflict: 409, backend_failure: 500, outcome_unknown: 500 };
            check('HTTP status matches outcome', events.filter(e => e.kind === 'client-response' && e.httpStatus !== (e.streamed ? 200 : protocol[e.status])).map(e => ({ id: e.clientAttemptId, status: e.status, httpStatus: e.httpStatus })), []);
            check('no client transport errors', events.filter(e => e.kind === 'client-error').length, 0);
            if (scenario.checks.includes('normal users complete'))
                check('normal users complete', events.filter(e => e.kind === 'client-response' && ['bob', 'carol'].includes(e.uid) && e.status === 'completed').length, 6);
            if (scenario.checks.includes('excess requests avoid database')) {
                const rejected = new Set(events.filter(e => e.kind === 'request-response' && ['admission_busy', 'execution_busy'].includes(e.status)).map(e => e.attemptId));
                check('excess requests avoid database', events.filter(e => e.kind === 'transaction-attempt' && rejected.has(e.attemptId)).length, 0);
                if (scenario.checks.includes('Alice peak matches guard'))
                    check('Alice peak matches guard', Math.max(...events.filter(e => e.kind === 'outstanding' && e.uid === 'alice').map(e => e.value)), scenario.options.maxOutstandingPerUid ?? 50);
            }
            check('all work settles', events.filter(e => e.kind === 'request-work-settled').length, events.filter(e => e.kind === 'request-start').length);
            if (scenario.checks.includes('burst rejection count'))
                check('burst rejection count', events.filter(e => e.kind === 'client-response' && e.status === 'admission_busy' && e.uid === 'alice').length, scenario.options.maxOutstandingPerUid ? 48 : 0);
            if (scenario.checks.includes('instance outcomes'))
                check('instance outcomes', { completed: events.filter(e => e.kind === 'client-response' && e.status === 'completed').length, rejected: events.filter(e => e.kind === 'client-response' && e.reason === 'instance_capacity').length }, { completed: 16, rejected: 4 });
            if (scenario.checks.includes('instance peak matches guard'))
                check('instance peak matches guard', Math.max(...events.filter(e => e.kind === 'outstanding').map(e => e.instanceValue)), 16);
            if (scenario.checks.includes('retry blocked until settlement')) {
                const response = requestId => events.find(e => e.kind === 'request-response' && e.requestId === requestId);
                check('retry blocked until settlement', { status: response('retry')?.status, reason: response('retry')?.reason }, { status: 'admission_busy', reason: scenario.options.maxOutstanding === 2 ? 'instance_capacity' : 'user_capacity' });
                check('recovery succeeds', response('recovered')?.status, 'completed');
                check('expired admissions never dispatch', events.filter(e => e.kind === 'inference-dispatch' && !['bob', 'carol'].includes(e.uid)).map(e => e.requestId), ['recovered']);
                const ordered = events.filter(e => e.role === 'server').sort((a, b) => a.localSequence - b.localSequence);
                const retry = ordered.find(e => e.kind === 'request-response' && e.requestId === 'retry');
                check('timed out work settles after response', ordered.filter(e => e.kind === 'request-work-settled' && e.afterDeadline && e.localSequence > retry?.localSequence).length, 2);
                check('disconnects observed', events.filter(e => e.kind === 'client-disconnected').length, scenario.schedule.filter(e => e.disconnectMs !== undefined).length);
            }
            if (scenario.lifecycle) assessLifecycle(events, scenario, check);
            else if (scenario.execution) assessExecution(events, scenario, check);
            row.status = 'complete';
        }
        catch (error) {
            row.status = 'error';
            row.error = String(error);
        }
        finally {
            clearTimeout(timer);
            if (generator)
                await generator.close();
            if (server)
                await server.close();
        }
    }
    result.requests = result.events.filter(e => ['request-start', 'request-response'].includes(e.kind));
    result.transactions = result.events.filter(e => e.kind.startsWith('transaction-'));
    result.admissions = result.events.filter(e => e.kind === 'admission-decision');
    result.observations = result.events.filter(e => ['outstanding', 'execution-reservation', 'provider-active', 'server-resource-sample', 'server-resource-summary'].includes(e.kind));
    result.run.finishedAt = new Date().toISOString();
    return result;
}
