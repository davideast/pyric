// Durable simulated work stored in Firestore (`provider/{key}`), not an AI provider.
export function durableProvider(store, context, record = () => {}) {
    const path = key => `provider/${key}`;
    return {
        async start(key, uid = context.uid) {
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
                    state: 'running',
                    stopRequested: false,
                    unavailable: false,
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
                tx.put(path(key), { ...job, state, stopRequested: false });
            });
            record('fixture-provider-terminated', { key, state });
            return { key, state };
        },

        async stop(key) {
            await store.transaction({ ...context, phase: 'fixture-provider-stop' }, async tx => {
                const job = await tx.get(path(key));
                if (!job) throw new Error('missing-provider-operation');
                tx.put(path(key), { ...job, stopRequested: true });
            });
            record('fixture-provider-stop-requested', { key });
            return { key, stopRequested: true };
        },

        async unavailable(key, isUnavailable = true) {
            await store.transaction({ ...context, phase: 'fixture-provider-unavailable' }, async tx => {
                const job = await tx.get(path(key)) ?? {
                    key,
                    uid: context.uid,
                    state: 'absent',
                    stopRequested: false,
                    hidden: false,
                    startAttempts: 0,
                    observations: 0,
                };
                tx.put(path(key), { ...job, unavailable: Boolean(isUnavailable) });
            });
            record('fixture-provider-unavailable', { key, unavailable: Boolean(isUnavailable) });
            return { key, unavailable: Boolean(isUnavailable) };
        },

        async hide(key, isHidden = true) {
            await store.transaction({ ...context, phase: 'fixture-provider-hide' }, async tx => {
                const job = await tx.get(path(key)) ?? {
                    key,
                    uid: context.uid,
                    state: 'absent',
                    stopRequested: false,
                    unavailable: false,
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
            if (job?.unavailable) state = 'unavailable';
            else if (job?.hidden) state = 'absent';
            else if (job?.stopRequested && job?.state === 'running') state = 'stop-pending';
            record('provider-observation', { key, state });
            return { key, state };
        },
    };
}
