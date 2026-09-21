// Independent fixture oracle. Survives gateway process crashes.
// This is NOT a claim about any real AI provider's idempotency or termination API.
// The 'observable' profile: explicit stop is acknowledged by the oracle controller.

export function createProvider(record) {
    const jobs      = new Map();  // key -> { key, uid, state }
    const hidden    = new Set();  // keys with hidden state (simulate unobservable)
    let peak        = 0;
    let peakPerUser = 0;
    let startAttempts = 0;

    return {
        /** Start a provider job. Throws 'duplicate-provider-dispatch' if key already exists. */
        start(key, uid) {
            startAttempts += 1;
            record('fixture-provider-start-attempt', { key, uid, startAttempts });
            if (jobs.has(key)) throw Object.assign(new Error('duplicate-provider-dispatch'), { code: 'duplicate-provider-dispatch' });
            const job = { key, uid, state: 'running' };
            jobs.set(key, job);
            const active = [...jobs.values()].filter(j => j.state === 'running');
            peak        = Math.max(peak, active.length);
            peakPerUser = Math.max(peakPerUser, ...active.map(j => active.filter(o => o.uid === j.uid).length), 0);
            record('fixture-provider-start', { ...job, active: active.length });
            return { ...job };
        },

        /** Observe a job's current state. Hidden keys return 'unknown'. */
        observe(key) {
            const job   = jobs.get(key);
            let   state = job?.state ?? 'absent';
            if (hidden.has(key)) state = 'unknown';
            record('provider-observation', { key, state });
            return { key, state };
        },

        /** Finish a running job with 'completed' or 'cancelled'. */
        finish(key, state = 'completed') {
            if (!['completed', 'cancelled'].includes(state)) throw Object.assign(new Error('invalid-provider-state'), { code: 'invalid-provider-state' });
            const job = jobs.get(key);
            if (!job) throw Object.assign(new Error('unknown-provider-key'), { code: 'unknown-provider-key' });
            job.state = state;
            record('fixture-provider-terminated', { key, state });
        },

        /** Hide the job state to simulate unobservable outcome. */
        hide(key) { hidden.add(key); record('fixture-provider-hidden', { key }); },

        /** Reveal the job state. */
        reveal(key) { hidden.delete(key); record('fixture-provider-visible', { key }); },

        snapshot() {
            return {
                jobs:          [...jobs.values()].map(j => ({ ...j })),
                peak,
                peakPerUser,
                startAttempts,
            };
        },
    };
}
