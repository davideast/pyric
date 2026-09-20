// Remote activity is a fixture oracle, separate from what the gateway can know.
// Production adapters must not infer remote termination from a fetch rejection.
export function scriptedProvider(record, config = {}) {
    const pending = new Set();
    let active = 0;
    const byUser = new Map();
    return {
        async drain() { await Promise.all([...pending]); },
        start(request, { signal, onChunk, attemptId, instanceId }) {
            const meta = { attemptId, instanceId, requestId: request.requestId, uid: request.uid, category: request.category };
            const options = { delayMs: 40, ...config, ...config.requests?.[request.requestId] };
            const duration = options.delayByRequest?.[request.requestId] ?? options.delayMs;
            let resolveResult, rejectResult, resolveTermination, resolveRemote;
            const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
            const termination = new Promise(resolve => { resolveTermination = resolve; });
            const remote = new Promise(resolve => { resolveRemote = resolve; });
            pending.add(remote);
            let finished = false, transportEnded = false, outcomeUnavailable = false;
            const timers = [];
            const transport = error => {
                if (transportEnded) return;
                transportEnded = true;
                record('transport-ended', { ...meta, reason: error?.message ?? 'completed' });
                if (error) rejectResult(error); else resolveResult({ text: 'fixture response' });
            };
            const finish = outcome => {
                if (finished) return;
                finished = true;
                timers.forEach(clearTimeout);
                signal.removeEventListener('abort', cancel);
                active--;
                byUser.set(request.uid, byUser.get(request.uid) - 1);
                record('fixture-remote-finished', { ...meta, outcome, evidence: 'fixture-oracle-only' });
                record('fixture-remote-active', { ...meta, value: byUser.get(request.uid), instanceValue: active });
                if (!outcomeUnavailable) {
                    if (outcome === 'cancelled') record('provider-cancel-confirmed', meta);
                    record('provider-settled', { ...meta, outcome });
                    resolveTermination({ outcome, evidence: 'scripted-provider-confirmation' });
                }
                if (options.resultMode === 'pending') record('transport-pending', meta);
                else if (options.resultMode === 'resolve') transport(null);
                else transport(outcome === 'cancelled' ? new Error('provider_cancelled') : null);
                pending.delete(remote);
                resolveRemote();
            };
            const cancel = () => {
                record('provider-cancel-requested', { ...meta, cancellation: options.cancellation ?? 'ignore', reason: String(signal.reason) });
                if (options.abortTransport) transport(new Error('transport_aborted'));
                if (options.cancellation === 'confirm') timers.push(setTimeout(() => finish('cancelled'), options.cancelDelayMs ?? 80));
            };
            record('inference-dispatch', meta);
            active++;
            byUser.set(request.uid, (byUser.get(request.uid) ?? 0) + 1);
            record('fixture-remote-active', { ...meta, value: byUser.get(request.uid), instanceValue: active });
            signal.addEventListener('abort', cancel, { once: true });
            for (let i = 0; i < (options.chunks ?? 0); i++) timers.push(setTimeout(() => {
                if (transportEnded) return;
                record('provider-chunk', { ...meta, index: i });
                onChunk?.({ index: i, text: 'fixture chunk' });
            }, duration * (i + 1) / (options.chunks + 1)));
            if (options.unknownAfterMs !== undefined) timers.push(setTimeout(() => {
                outcomeUnavailable = true;
                transport(new Error('transport_lost'));
                resolveTermination({ outcome: 'unknown', evidence: 'no-provider-confirmation' });
            }, options.unknownAfterMs));
            timers.push(setTimeout(() => finish(options.terminalOutcome ?? 'completed'), duration));
            if (signal.aborted) cancel();
            return { result, termination };
        },
    };
}
