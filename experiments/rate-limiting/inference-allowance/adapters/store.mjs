import { randomUUID } from 'node:crypto';
const copy = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
// Both adapters use native SDK transactions. No simulated lock manager or retry loop.
export function instrumentStore(db, root, record, { maxAttempts = 8, fault = async (_phase, _meta) => { } } = {}) {
    const ref = path => db.doc(`${root}/${path}`);
    const get = async (path) => copy((await ref(path).get()).data());
    return {
        get,
        put: (path, data) => ref(path).set(data),
        async transaction(context, fn) {
            const invocationId = randomUUID();
            let attempt = 0;
            const base = { requestId: context.requestId, attemptId: context.attemptId ?? null, instanceId: context.instanceId ?? null, invocationId, phase: context.phase ?? 'admission', uid: context.uid };
            try {
                await fault('beforeTransaction', base);
                const result = await db.runTransaction(async (native) => {
                    attempt++;
                    const meta = { ...base, attempt };
                    context.check?.();
                    record('transaction-attempt', meta);
                    const result = await fn({
                        async get(path) {
                            await fault('beforeRead', { ...meta, path });
                            const data = copy((await native.get(ref(path))).data());
                            record('transaction-read', { ...meta, path, data });
                            await fault('afterRead', { ...meta, path });
                            context.check?.();
                            return data;
                        },
                        put(path, data) {
                            context.check?.();
                            native.set(ref(path), data);
                            record('transaction-write-staged', { ...meta, path, data });
                        },
                    });
                    await fault('beforeCommit', meta);
                    context.check?.();
                    return result;
                }, { maxAttempts });
                record('transaction-acknowledged', { ...base, attempt });
                try {
                    await fault('afterCommit', { ...base, attempt });
                }
                catch (error) {
                    error.commitUnknown = true;
                    throw error;
                }
                return result;
            }
            catch (error) {
                record('transaction-error', { ...base, attempt, code: String(error.code ?? error.message) });
                throw error;
            }
        },
    };
}
