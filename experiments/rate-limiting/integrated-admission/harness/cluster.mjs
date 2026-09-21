import { randomUUID }      from 'node:crypto';
import { fork }            from 'node:child_process';
import { fileURLToPath }   from 'node:url';
import { readFileSync }    from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules }          from 'pyric/sandbox/firestore';
import { getAdminFirestore }  from 'pyric/sandbox/admin-firestore';
import { instrumentStore }    from '../../inference-allowance/adapters/store.mjs';
import { rpcMessage }        from '../services/rpc-message.mjs';
import { createProvider }    from '../services/provider-oracle.mjs';

/**
 * Spawn a multi-process cluster backed by a single in-process Pyric sandbox.
 * Each worker is a real child process (gateway-worker.mjs) that communicates
 * via IPC. The parent owns the Pyric SDK and brokers store operations.
 *
 * @param {{ record, fault?, limits, policies, runId, caseId }} opts
 */
export async function createCluster({ record, fault = async () => {}, limits, policies, runId, caseId }) {
    const sandbox  = initializeSandbox();
    setRules(sandbox, readFileSync(new URL('../architecture/firestore.rules', import.meta.url), 'utf8'));
    const db       = getAdminFirestore(sandbox.withAuth(null));
    const root     = `integratedAdmissionExperiments/${runId}/cases/${caseId}`;
    const inFlight = new Set();

    let activeFault = fault;
    const store = instrumentStore(db, root, record, { maxAttempts: 8, fault: (...args) => activeFault(...args) });

    const workers  = new Map();   // owner -> worker object
    const provider = createProvider(record);

    let now = 1000;   // logical clock, advanced by controller at barriers

    const send = (child, message) => { if (child.connected) child.send(message, () => {}); };

    async function spawn(owner) {
        const child = fork(
            fileURLToPath(new URL('../services/gateway-worker.mjs', import.meta.url)),
            [owner],
            { execPath: 'node', silent: true },
        );
        const commands    = new Map();   // id -> { resolve, reject }
        const transactions = new Map();  // attempt -> { tx, resolve, reject }

        const exited = new Promise(resolve => child.once('close', (code, signal) => {
            for (const p of [...commands.values(), ...transactions.values()]) p.reject(new Error('gateway-exited'));
            resolve({ code, signal });
            record('gateway-exit', { owner, processId: child.pid, code, signal });
        }));

        child.stdout.resume();
        child.stderr.on('data', bytes => record('gateway-stderr', { owner, text: bytes.toString().slice(0, 1000) }));

        const ready = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit',  () => reject(new Error('gateway-exited-before-ready')));
            child.on('message', async raw => {
                const message = rpcMessage(raw);
                if (!message) return;

                if (message.type === 'ready') {
                    record('gateway-ready', message);
                    resolve(undefined);
                    return;
                }

                if (message.type === 'command-result') {
                    const pending = commands.get(message.id);
                    if (!pending) return;
                    commands.delete(message.id);
                    if (message.error) pending.reject(Object.assign(new Error(message.error), { code: message.error }));
                    else pending.resolve(message.value);
                    return;
                }

                if (message.type !== 'rpc') return;

                try {
                    const { method, args } = message;
                    let value;
                    if (method === 'get') {
                        value = await store.get(args.path);
                    } else if (method === 'transaction') {
                        const transaction = store.transaction(args.context, tx => new Promise((resolve, reject) => {
                            if (!child.connected) { reject(new Error('gateway-exited')); return; }
                            const attempt = randomUUID();
                            transactions.set(attempt, { tx, resolve, reject });
                            send(child, { type: 'transaction-callback', key: args.key, attempt });
                        }));
                        inFlight.add(transaction);
                        try   { value = await transaction; }
                        finally { inFlight.delete(transaction); }
                    } else if (method === 'read') {
                        const active = transactions.get(args.attempt);
                        if (!active) throw new Error('stale-transaction');
                        value = await active.tx.get(args.path);
                    } else if (method === 'commit') {
                        const active = transactions.get(args.attempt);
                        if (!active) throw new Error('stale-transaction');
                        try {
                            if (args.error) throw Object.assign(new Error(args.error), { code: args.error });
                            for (const write of args.writes) active.tx.put(write.path, write.data);
                            active.resolve(args.result);
                        } catch (error) { active.reject(error); }
                        finally { transactions.delete(args.attempt); }
                    } else if (method === 'provider-start') {
                        value = provider.start(args.key, args.uid);
                    } else if (method === 'provider-finish') {
                        value = provider.finish(args.key, args.state);
                    } else if (method === 'provider-observe') {
                        value = provider.observe(args.key);
                    } else {
                        throw new Error('unsupported-rpc');
                    }
                    send(child, { type: 'reply', id: message.id, value });
                } catch (error) {
                    send(child, { type: 'reply', id: message.id, error: String(error.code ?? error.message) });
                }
            });
        });

        const worker = {
            child,
            exited,
            async command(operation, request, extra = {}) {
                const id = randomUUID();
                return new Promise((resolve, reject) => {
                    if (!child.connected) { reject(new Error('gateway-exited')); return; }
                    commands.set(id, { resolve, reject });
                    send(child, { type: 'command', id, operation, request, now, limits, policies, ...extra });
                });
            },
        };

        workers.set(owner, worker);
        await ready;
        return worker;
    }

    return {
        spawn,
        provider,
        store,
        workers,
        setFault(next) { activeFault = next; },
        advance(ms)    { now += ms; record('clock-advanced', { now, ms }); },

        async kill(owner) {
            const worker = workers.get(owner);
            record('fault-gateway-kill', { owner, processId: worker.child.pid, now });
            worker.child.kill('SIGKILL');
            await worker.exited;
        },

        async snapshot() {
            const cols = ['quotas', 'requests', 'capacity', 'users'];
            return Object.fromEntries(
                await Promise.all(cols.map(async name => [
                    name,
                    (await db.collection(`${root}/${name}`).get())
                        .docs.map(doc => ({ id: doc.id, data: doc.data() })),
                ])),
            );
        },

        async close() {
            for (const worker of workers.values()) {
                if (worker.child.connected) worker.child.kill('SIGKILL');
                await worker.exited;
            }
            await Promise.allSettled([...inFlight]);
        },
    };
}
