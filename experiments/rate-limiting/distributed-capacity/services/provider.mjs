// Independent fixture oracle survives gateway process death. This is not a
// claim about any real AI provider's idempotency or termination API.
export function createProvider(record) {
    const jobs = new Map(), hidden = new Set();
    let peak = 0, peakPerUser = 0, startAttempts = 0;
    return {
        start(key, uid) {
            startAttempts += 1;
            record('fixture-provider-start-attempt', { key, uid, startAttempts });
            if (jobs.has(key)) throw new Error('duplicate-provider-dispatch');
            const job = { key, uid, state: 'running' }; jobs.set(key, job);
            const active = [...jobs.values()].filter(job => job.state === 'running');
            peak = Math.max(peak, active.length);
            peakPerUser = Math.max(peakPerUser, ...active.map(job => active.filter(other => other.uid === job.uid).length));
            record('fixture-provider-start', { ...job, active: active.length }); return { ...job };
        },
        observe(key) {
            const job = jobs.get(key);
            let state = job?.state ?? 'absent';
            if (hidden.has(key)) state = 'unknown';
            record('provider-observation', { key, state }); return { key, state };
        },
        hide(key) { hidden.add(key); record('fixture-provider-hidden', { key }); },
        reveal(key) { hidden.delete(key); record('fixture-provider-visible', { key }); },
        finish(key, state = 'completed') {
            if (!['completed', 'cancelled'].includes(state) || !jobs.has(key)) throw new Error('invalid-provider-completion');
            jobs.get(key).state = state; record('fixture-provider-terminated', { key, state });
        },
        snapshot() { return { jobs: [...jobs.values()].map(job => ({ ...job })), peak, peakPerUser, startAttempts }; },
    };
}
