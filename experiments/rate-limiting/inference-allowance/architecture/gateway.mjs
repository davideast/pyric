import { randomUUID } from 'node:crypto';
import { admit, hash, receiptPath } from './admission.mjs';
export function createGateway({ store, authenticate, inference, policies, clock, record, deadlineMs = 2000, instanceId = 'local-1', maxOutstandingPerUid = Infinity, maxOutstanding = Infinity, admission = admit, allowedModels = ['test-model'], maxExecutionPerUid = Infinity, maxExecution = Infinity, inferenceTimeoutMs = null }) {
    const activeRequests = new Map();
    const executing = new Map();
    let executionPending = 0;
    const pending = new Map();
    const works = new Set();
    let instancePending = 0;
    return {
        async cancel({ token, body }) {
            const uid = await authenticate(token, { signal: new AbortController().signal });
            if (!uid) return { status: 'unauthenticated' };
            if (!body || Object.keys(body).some(key => key !== 'requestId') ||
                typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId))
                return { status: 'invalid_request' };
            const active = activeRequests.get(JSON.stringify([uid, body.requestId]));
            // Identical answer for absent requests and another user's request.
            if (!active) return { status: 'not_found' };
            active.cancel();
            return { status: 'cancellation_requested' };
        },
        async drain() { await Promise.allSettled([...works]); },
        async request({ token, route, body, signal = undefined, onChunk = undefined }) {
            const attemptId = randomUUID();
            const started = performance.now();
            const abort = new AbortController();
            let uid = null, outstanding = false, executionReserved = false, phase = 'authentication', activeKey, activeEntry, quarantined = false;
            const release = () => {
                if (!outstanding)
                    return;
                outstanding = false;
                pending.set(uid, pending.get(uid) - 1);
                instancePending--;
                if (!pending.get(uid))
                    pending.delete(uid);
                record('outstanding', { uid, instanceId, value: pending.get(uid) ?? 0, instanceValue: instancePending });
            };
            const releaseExecution = () => {
                if (executionReserved && !quarantined) {
                    executionReserved = false;
                    executing.set(uid, executing.get(uid) - 1);
                    executionPending--;
                    record('execution-reservation', { action: 'release', uid, instanceId, attemptId, requestId: body.requestId, value: executing.get(uid), instanceValue: executionPending });
                    if (!executing.get(uid)) executing.delete(uid);
                }
            };
            const check = () => {
                if (abort.signal.aborted || (phase !== 'inference' && performance.now() - started >= deadlineMs)) {
                    throw new Error('admission_deadline');
                }
            };
            let timer, finishTimeout;
            const timeout = new Promise(resolve => {
                finishTimeout = resolve;
                timer = setTimeout(() => {
                    abort.abort('admission_deadline');
                    resolve({ status: 'admission_timeout' });
                }, deadlineMs);
            });
            const cancel = () => {
                record('client-cancel-requested', { uid, instanceId, attemptId, requestId: body?.requestId ?? null, phase });
                finishTimeout({ status: 'client_cancelled' });
                abort.abort('client_cancelled');
            };
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            record('request-start', { attemptId, requestId: body?.requestId ?? null, instanceId });
            const work = (async () => {
                uid = await authenticate(token, { signal: abort.signal });
                check();
                if (!uid)
                    return { status: 'unauthenticated' };
                if (!['chat', 'agent'].includes(route) || !body ||
                    Object.keys(body).some(key => !['requestId', 'model', 'prompt'].includes(key)) ||
                    typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId) ||
                    !allowedModels.includes(body.model) || typeof body.prompt !== 'string' || body.prompt.length > 2000) {
                    return { status: 'invalid_request' };
                }
                if ((pending.get(uid) ?? 0) >= maxOutstandingPerUid)
                    return { status: 'admission_busy', reason: 'user_capacity' };
                if (instancePending >= maxOutstanding)
                    return { status: 'admission_busy', reason: 'instance_capacity' };
                if ((executing.get(uid) ?? 0) >= maxExecutionPerUid)
                    return { status: 'execution_busy', reason: 'user_execution_capacity' };
                if (executionPending >= maxExecution)
                    return { status: 'execution_busy', reason: 'instance_execution_capacity' };
                executionReserved = true;
                executing.set(uid, (executing.get(uid) ?? 0) + 1);
                executionPending++;
                record('execution-reservation', { action: 'acquire', uid, instanceId, attemptId, requestId: body.requestId, value: executing.get(uid), instanceValue: executionPending });
                pending.set(uid, (pending.get(uid) ?? 0) + 1);
                outstanding = true;
                instancePending++;
                record('outstanding', { uid, instanceId, value: pending.get(uid) ?? 0, instanceValue: instancePending });
                phase = 'admission';
                const request = { ...body, uid, category: route, payloadHash: hash([route, body.model, body.prompt]) };
                activeKey = JSON.stringify([uid, body.requestId]);
                if (!activeRequests.has(activeKey)) {
                    activeEntry = { cancel() {
                        if (abort.signal.aborted) return;
                        record('explicit-cancel-requested', { uid, instanceId, attemptId, requestId: body.requestId, phase });
                        finishTimeout({ status: 'cancellation_requested' });
                        abort.abort('explicit_cancel');
                    } };
                    activeRequests.set(activeKey, activeEntry);
                }
                const context = { uid, requestId: body.requestId, attemptId, instanceId, check };
                const decision = await admission(store, request, policies, clock, context);
                record('admission-decision', { uid, attemptId, instanceId, requestId: request.requestId,
                    status: decision.status, retryAfterMs: decision.retryAfterMs ?? null });
                if (!['admitted', 'duplicate'].includes(decision.status))
                    return decision;
                check();
                phase = 'dispatch';
                const path = receiptPath(uid, request.requestId);
                const claimed = await store.transaction({ ...context, phase }, async (tx) => {
                    const saved = await tx.get(path);
                    if (saved?.state !== 'admitted')
                        return false;
                    tx.put(path, { ...saved, state: 'dispatching' });
                    return true;
                });
                check();
                if (!claimed)
                    return { status: 'duplicate' };
                clearTimeout(timer);
                phase = 'inference';
                release();
                if (inferenceTimeoutMs !== null) timer = setTimeout(() => {
                    record('inference-deadline', { uid, instanceId, attemptId, requestId: body.requestId });
                    finishTimeout({ status: 'inference_timeout' });
                    abort.abort('inference_deadline');
                }, inferenceTimeoutMs);
                try {
                    const options = { signal: abort.signal, onChunk, attemptId, instanceId };
                    if (!inference.start) {
                        // Legacy experiments retain their original promise-settlement contract.
                        await inference.generate(request, options);
                        return { status: 'completed' };
                    }
                    let outcome = { outcome: 'unknown', evidence: 'adapter-error' };
                    let transport = Promise.resolve({ status: 'outcome_unknown' });
                    try {
                        const operation = inference.start(request, options);
                        let observedTermination;
                        // Register termination first so already-confirmed
                        // cancellation wins over an already-rejected transport.
                        const termination = Promise.resolve(operation.termination).then(
                            value => (observedTermination = value),
                            () => (observedTermination = { outcome: 'unknown', evidence: 'termination-error' }));
                        transport = Promise.resolve(operation.result).then(
                            () => ({ status: 'completed' }),
                            () => {
                                if (!['completed', 'cancelled'].includes(observedTermination?.outcome))
                                    finishTimeout({ status: 'outcome_unknown' });
                                return { status: 'outcome_unknown' };
                            });
                        // Observe termination independently: a stuck transport
                        // cannot hide confirmed cancellation or retain its slot.
                        outcome = await termination;
                    } catch { /* Unknown after a dispatch claim: retain capacity. */ }
                    const known = ['completed', 'cancelled'].includes(outcome?.outcome);
                    quarantined = !known;
                    record('provider-outcome', { uid, instanceId, attemptId, requestId: body.requestId,
                        outcome: known ? outcome.outcome : 'unknown', evidence: outcome?.evidence ?? 'invalid-termination-evidence' });
                    if (quarantined) {
                        record('execution-quarantined', { uid, instanceId, attemptId, requestId: body.requestId, reason: 'unknown-provider-outcome' });
                        return { status: 'outcome_unknown' };
                    }
                    releaseExecution();
                    if (outcome.outcome === 'cancelled') return { status: 'provider_cancelled' };
                    // Provider completion is known, but output can still be in
                    // transit. The request deadline bounds waiting for output.
                    let stopWaiting;
                    const interrupted = new Promise(resolve => {
                        stopWaiting = () => resolve({ status: 'outcome_unknown' });
                        if (abort.signal.aborted) stopWaiting();
                        else abort.signal.addEventListener('abort', stopWaiting, { once: true });
                    });
                    try { return await Promise.race([transport, interrupted]); }
                    finally { abort.signal.removeEventListener('abort', stopWaiting); }
                }
                catch {
                    return { status: 'outcome_unknown' };
                }
            })();
            works.add(work);
            work.finally(() => {
                works.delete(work);
                if (activeEntry && activeRequests.get(activeKey) === activeEntry) activeRequests.delete(activeKey);
                release();
                releaseExecution();
                record('request-work-settled', { attemptId, uid, instanceId, phase,
                    afterDeadline: ['admission_deadline', 'inference_deadline'].includes(abort.signal.reason), abortReason: abort.signal.aborted ? String(abort.signal.reason) : null, outstandingWork: works.size });
            }).catch(() => { });
            let response;
            try {
                response = await Promise.race([work, timeout]);
            }
            catch (error) {
                response = { status: error.message === 'admission_deadline' ? 'admission_timeout' :
                        error.commitUnknown ? 'outcome_unknown' : 'backend_failure', code: String(error.code ?? error.message) };
            }
            finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
            }
            record('request-response', { attemptId, requestId: body?.requestId ?? null, uid, instanceId,
                status: response.status, reason: response.reason ?? null, durationMs: performance.now() - started });
            return response;
        },
    };
}
