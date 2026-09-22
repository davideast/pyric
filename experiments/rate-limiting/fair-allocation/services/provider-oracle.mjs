export function createProviderOracle() {
    const jobs = new Map();
    const userActive = new Map();
    let active = 0;
    let peak = 0;
    let peakPerUser = 0;
    let startAttempts = 0;

    return {
        start(key, uid, { durationMs = 200, startedAt = 0 } = {}) {
            startAttempts++;
            const existing = jobs.get(key);
            if (existing) {
                existing.startAttempts++;
                return existing;
            }
            active++;
            if (active > peak) peak = active;
            const uCur = (userActive.get(uid) ?? 0) + 1;
            userActive.set(uid, uCur);
            if (uCur > peakPerUser) peakPerUser = uCur;

            const job = {
                key,
                uid,
                state: 'running',
                hidden: false,
                durationMs,
                startedAt,
                endsAt: startedAt + durationMs,
                completedAt: null,
                startAttempts: 1,
            };
            jobs.set(key, job);
            return job;
        },

        finish(key, outcome = 'completed', now = 0) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            if (job.state === 'running') {
                active = Math.max(0, active - 1);
                userActive.set(job.uid, Math.max(0, (userActive.get(job.uid) ?? 1) - 1));
            }
            job.state = outcome;
            job.completedAt = now;
            return job;
        },

        hide(key) {
            const job = jobs.get(key);
            if (!job) throw new Error('missing-provider-operation');
            job.hidden = true;
            return job;
        },

        observe(key) {
            const job = jobs.get(key);
            if (!job) return { key, state: 'absent' };
            if (job.hidden) return { key, state: 'unknown' };
            return { key, state: job.state };
        },

        dueRunning(now) {
            const due = [];
            for (const job of jobs.values()) {
                if (job.state === 'running' && !job.hidden && job.endsAt <= now) {
                    due.push(job);
                }
            }
            return due;
        },

        snapshot() {
            return {
                active,
                peak,
                peakPerUser,
                startAttempts,
                jobs: [...jobs.values()],
            };
        },
    };
}
