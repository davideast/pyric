// Observable fake provider. Cancellation confirmation is simulated explicitly;
// an AbortSignal alone is never counted as provider settlement.
export function lifecycleInference(record, { delayMs = 600, delayByRequest = {}, cancellation = 'ignore', cancelDelayMs = 80, chunks = 0, failures = [] } = {}) {
    let active = 0;
    const byUser = new Map();
    return { async generate(request, { signal, onChunk, attemptId, instanceId } = {}) {
        const meta = { attemptId, instanceId, requestId: request.requestId, uid: request.uid, category: request.category };
        active++; byUser.set(request.uid, (byUser.get(request.uid) ?? 0) + 1);
        record('inference-dispatch', meta);
        record('provider-active', { ...meta, value: byUser.get(request.uid), instanceValue: active });
        let outcome = 'completed';
        try {
            await new Promise((resolve, reject) => {
                let finished = false, cancelTimer;
                const timers = [];
                const finish = error => {
                    if (finished) return;
                    finished = true;
                    for (const timer of timers) clearTimeout(timer);
                    clearTimeout(cancelTimer);
                    signal?.removeEventListener('abort', cancel);
                    if (error) reject(error); else resolve();
                };
                const cancel = () => {
                    record('provider-cancel-requested', { ...meta, cancellation });
                    if (cancellation === 'confirm') cancelTimer = setTimeout(() => {
                        record('provider-cancel-confirmed', meta);
                        finish(new Error('provider_cancelled'));
                    }, cancelDelayMs);
                };
                signal?.addEventListener('abort', cancel, { once: true });
                const duration = delayByRequest[request.requestId] ?? delayMs;
                for (let i = 0; i < chunks; i++) timers.push(setTimeout(() => {
                    const chunk = { index: i, text: 'fixture chunk' };
                    record('provider-chunk', { ...meta, index: i });
                    onChunk?.(chunk);
                }, duration * (i + 1) / (chunks + 1)));
                timers.push(setTimeout(() => finish(failures.includes(request.requestId) ? new Error('provider_failure') : null), duration));
                if (signal?.aborted) cancel();
            });
            record('inference-complete', meta);
            return { text: 'fixture response' };
        } catch (error) {
            outcome = error.message;
            record('provider-error', { ...meta, outcome });
            throw error;
        } finally {
            active--; byUser.set(request.uid, byUser.get(request.uid) - 1);
            record('provider-settled', { ...meta, outcome });
            record('provider-active', { ...meta, value: byUser.get(request.uid), instanceValue: active });
        }
    } };
}
