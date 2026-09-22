/**
 * Independent host fixture provider oracle for automatic recovery.
 * Tracks real active remote inference independently of Firestore reservations so
 * unsafe early slot release (peak > limit) is immediately detected.
 * Supports transient unavailability, pending stop requests, and permanent unobservability.
 */
export function createProviderOracle(record = () => {}) {
    const jobs          = new Map();
    const activePerUser = new Map();
    let active          = 0;
    let peak            = 0;
    let peakPerUser     = 0;
    let startAttempts   = 0;
    let observations    = 0;

    return {
        start(key, uid) {
            startAttempts++;
            record('fixture-provider-start-attempt', { key, uid });
            if (jobs.has(key)) throw new Error('duplicate-provider-dispatch');
            active++;
            peak = Math.max(peak, active);
            const userActive = (activePerUser.get(uid) ?? 0) + 1;
            activePerUser.set(uid, userActive);
            peakPerUser = Math.max(peakPerUser, userActive);
            const job = { key, uid, state: 'running', hidden: false, unavailableCount: 0, stopPending: false };
            jobs.set(key, job);
            record('fixture-provider-start', { key, uid, active, peak });
            return { key, uid, state: 'running' };
        },

        observe(key) {
            observations++;
            const job = jobs.get(key);
            if (!job) {
                record('provider-observation', { key, state: 'absent' });
                return { key, state: 'absent' };
            }
            if (job.hidden) {
                record('provider-observation', { key, state: 'unknown' });
                return { key, state: 'unknown' };
            }
            if (job.unavailableCount > 0) {
                job.unavailableCount--;
                record('provider-observation', { key, state: 'unavailable' });
                return { key, state: 'unavailable' };
            }
            const state = job.stopPending && job.state === 'running' ? 'stop-pending' : job.state;
            record('provider-observation', { key, state });
            return { key, state };
        },

        finish(key, state) {
            if (!['completed', 'cancelled'].includes(state)) throw new Error('invalid-provider-outcome');
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            if (job.state === 'running') {
                active = Math.max(0, active - 1);
                activePerUser.set(job.uid, Math.max(0, (activePerUser.get(job.uid) ?? 0) - 1));
            }
            job.state = state;
            job.stopPending = false;
            record('fixture-provider-terminated', { key, state, active });
            return { key, state };
        },

        requestStop(key) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            job.stopPending = true;
            record('fixture-provider-stop-requested', { key });
            return { key, state: 'stop-pending' };
        },

        setUnavailable(key, count = 1) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            job.unavailableCount = count;
            record('fixture-provider-unavailable-set', { key, count });
            return { key, unavailableCount: count };
        },

        hide(key) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            job.hidden = true;
            record('fixture-provider-hidden', { key });
            return { key, hidden: true };
        },

        reveal(key) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            job.hidden = false;
            record('fixture-provider-revealed', { key });
            return { key, hidden: false };
        },

        snapshot() {
            return {
                active,
                peak,
                peakPerUser,
                startAttempts,
                observations,
                jobs: [...jobs.values()].map(j => ({ ...j })),
            };
        },
    };
}
