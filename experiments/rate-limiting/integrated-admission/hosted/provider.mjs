// Durable simulated work stored in Firestore (`provider/{key}`), not an AI provider.
// No timer or local process owns its lifetime: only an explicit fixture command
// can record completion, cancellation, or hidden/unobservable status.
export function durableProvider(store, context, record) {
    const ref = key => `provider/${key}`;
    return {
        async start(key, uid) {
            record('fixture-provider-start-attempt', { key, uid });
            const job = await store.transaction({ ...context, phase: 'fixture-provider' }, async tx => {
                if (await tx.get(ref(key))) throw new Error('duplicate-provider-dispatch');
                const job = { key, uid, state: 'running', hidden: false };
                tx.put(ref(key), job);
                return job;
            });
            record('fixture-provider-start', { key, uid });
            return job;
        },
        async observe(key) {
            const job = await store.get(ref(key));
            let state = job?.state ?? 'absent';
            if (job?.hidden) state = 'unknown';
            record('provider-observation', { key, state });
            return { key, state };
        },
        async finish(key, state) {
            if (!['completed', 'cancelled'].includes(state)) throw new Error('invalid-provider-outcome');
            await store.transaction({ ...context, phase: 'fixture-provider' }, async tx => {
                const job = await tx.get(ref(key));
                if (!job) throw new Error('missing-provider-operation');
                if (job.state !== 'running' && job.state !== state) throw new Error('conflicting-provider-outcome');
                tx.put(ref(key), { ...job, state });
            });
            record('fixture-provider-terminated', { key, state });
            return { key, state };
        },
        async hide(key) {
            await store.transaction({ ...context, phase: 'fixture-provider' }, async tx => {
                const job = await tx.get(ref(key));
                if (!job) throw new Error('missing-provider-operation');
                tx.put(ref(key), { ...job, hidden: true });
            });
            record('fixture-provider-hidden', { key });
            return { key, hidden: true };
        },
    };
}
