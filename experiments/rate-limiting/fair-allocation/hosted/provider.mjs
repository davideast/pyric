// Durable simulated work stored in Firestore (`provider/{key}`), not an AI provider.
export function durableProvider(store, context, record = () => {}) {
    const path = key => `provider/${key}`;
    return {
        async start(key, uid = context.uid, durationMs = 200) {
            record('fixture-provider-start-attempt', { key, uid });
            const job = await store.transaction({ ...context, phase: 'fixture-provider-start' }, async tx => {
                const existing = await tx.get(path(key));
                if (existing) {
                    const updated = { ...existing, startAttempts: (existing.startAttempts ?? 1) + 1 };
                    tx.put(path(key), updated);
                    return updated;
                }
                const created = {
                    key,
                    uid,
                    durationMs,
                    state: 'running',
                    hidden: false,
                    startAttempts: 1,
                    observations: 0,
                };
                tx.put(path(key), created);
                return created;
            });
            record('fixture-provider-start', { key, uid });
            return job;
        },

        async finish(key, state = 'completed') {
            if (!['completed', 'cancelled'].includes(state)) throw new Error('invalid-provider-outcome');
            await store.transaction({ ...context, phase: 'fixture-provider-finish' }, async tx => {
                const job = await tx.get(path(key));
                if (!job) throw new Error('missing-provider-operation');
                tx.put(path(key), { ...job, state });
            });
            record('fixture-provider-terminated', { key, state });
            return { key, state };
        },

        async hide(key, isHidden = true) {
            await store.transaction({ ...context, phase: 'fixture-provider-hide' }, async tx => {
                const job = await tx.get(path(key)) ?? {
                    key,
                    uid: context.uid,
                    durationMs: 200,
                    state: 'absent',
                    startAttempts: 0,
                    observations: 0,
                };
                tx.put(path(key), { ...job, hidden: Boolean(isHidden) });
            });
            record('fixture-provider-hidden', { key, hidden: Boolean(isHidden) });
            return { key, hidden: Boolean(isHidden) };
        },

        async observe(key) {
            const job = await store.get(path(key));
            let state = job?.state ?? 'absent';
            if (job?.hidden) state = 'unknown';
            record('provider-observation', { key, state });
            return { key, state };
        },
    };
}
