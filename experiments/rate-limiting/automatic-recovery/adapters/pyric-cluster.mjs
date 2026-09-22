import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { createProviderOracle } from '../services/provider-oracle.mjs';
import { rpcMessage } from '../services/rpc-message.mjs';
import { POLICIES, LIMITS, RECOVERY_BUDGET } from '../fixtures/contracts.mjs';

const gatewayWorkerScript  = fileURLToPath(new URL('../services/gateway-worker.mjs', import.meta.url));
const recoveryWorkerScript = fileURLToPath(new URL('../services/recovery-worker.mjs', import.meta.url));

/**
 * Multi-process cluster coordinating gateway subprocesses, recovery worker subprocesses,
 * shared Pyric Admin Firestore sandbox, and independent provider oracle.
 */
export async function createRecoveryCluster({
    record = () => {},
    limits = LIMITS,
    policies = POLICIES,
    budget = RECOVERY_BUDGET,
    runId = 'local-run',
    caseId = 'case-1',
} = {}) {
    const db       = getAdminFirestore(initializeSandbox().withAuth(null));
    const root     = `automaticRecoveryExperiments/${runId}/cases/${caseId}`;
    let activeFault = async () => {};

    const store    = instrumentStore(db, root, record, { maxAttempts: 8, fault: (phase, meta) => activeFault(phase, meta) });
    const provider = createProviderOracle(record);
    const workers  = new Map();
    let clockMs    = 1000;

    async function listRequests() {
        const snap = await db.collection(`${root}/requests`).get();
        return snap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    }

    async function spawnProcess(script, owner, { clockOffsetMs = 0 } = {}) {
        if (workers.has(owner)) throw new Error(`Worker already exists: ${owner}`);
        const child = fork(script, [owner], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const pendingCommands = new Map();
        const transactions    = new Map();

        child.on('exit', (code, signal) => {
            for (const waiter of pendingCommands.values()) {
                waiter.reject(new Error('worker-exited'));
            }
            pendingCommands.clear();
            record('worker-exit', { owner, pid: child.pid, code, signal });
        });

        child.on('message', async raw => {
            const msg = rpcMessage(raw);
            if (!msg) return;

            if (msg.type === 'command-result') {
                const waiter = pendingCommands.get(msg.id);
                if (!waiter) return;
                pendingCommands.delete(msg.id);
                if (msg.error) waiter.reject(Object.assign(new Error(msg.error), { code: msg.error }));
                else waiter.resolve(msg.value);
                return;
            }

            if (msg.type === 'transaction-result') {
                const tx = transactions.get(msg.attempt);
                if (!tx) return;
                if (msg.error) tx.reject(Object.assign(new Error(msg.error), { code: msg.error }));
                else tx.resolve(msg.value);
                return;
            }

            if (msg.type === 'rpc-call') {
                const { id, method, args } = msg;
                try {
                    let value;
                    if (method === 'get') {
                        value = await store.get(args.path);
                    } else if (method === 'list-requests') {
                        value = await listRequests();
                    } else if (method === 'read') {
                        const tx = transactions.get(args.attempt);
                        if (!tx) throw new Error('missing-transaction-attempt');
                        value = await tx.nativeTx.get(args.path);
                    } else if (method === 'commit') {
                        const tx = transactions.get(args.attempt);
                        if (!tx) throw new Error('missing-transaction-attempt');
                        for (const [path, data] of args.writes) {
                            tx.nativeTx.put(path, data);
                        }
                        value = true;
                    } else if (method === 'transaction') {
                        const attempt = randomUUID();
                        value = await store.transaction(args.context, async nativeTx => {
                            return new Promise((resolve, reject) => {
                                transactions.set(attempt, { nativeTx, resolve, reject });
                                child.send({ type: 'transaction-callback', callId: args.callId, attempt });
                            });
                        });
                        transactions.delete(attempt);
                    } else if (method === 'provider-start') {
                        value = provider.start(args.key, args.uid);
                    } else if (method === 'provider-observe') {
                        value = provider.observe(args.key);
                    } else if (method === 'provider-finish') {
                        value = provider.finish(args.key, args.state);
                    } else {
                        throw new Error(`Unsupported RPC method: ${method}`);
                    }
                    if (child.connected) child.send({ type: 'rpc-reply', id, value });
                } catch (error) {
                    if (child.connected) child.send({ type: 'rpc-reply', id, error: error.code ?? error.message });
                }
            }
        });

        const handle = {
            owner,
            pid: child.pid,
            command(operation, request = null, extra = {}) {
                return new Promise((resolve, reject) => {
                    if (!child.connected) return reject(new Error('worker-exited'));
                    const id = randomUUID();
                    pendingCommands.set(id, { resolve, reject });
                    child.send({
                        type: 'command',
                        id,
                        operation,
                        request,
                        now: clockMs + clockOffsetMs,
                        policies,
                        limits,
                        budget,
                        ...extra,
                    });
                });
            },
            async kill() {
                if (child.exitCode === null && child.signalCode === null) {
                    record('fault-worker-kill', { owner, pid: child.pid });
                    await new Promise(resolve => {
                        child.once('exit', resolve);
                        child.kill('SIGKILL');
                    });
                }
            },
        };

        workers.set(owner, handle);
        record('worker-spawn', { owner, pid: child.pid, script });
        return handle;
    }

    return {
        store,
        provider,
        now: () => clockMs,
        advance(deltaMs) {
            clockMs += deltaMs;
            record('clock-advance', { deltaMs, now: clockMs });
            return clockMs;
        },
        setFault(fn) {
            activeFault = fn;
        },
        spawnGateway: (owner, opts) => spawnProcess(gatewayWorkerScript, owner, opts),
        spawnRecoveryWorker: (owner, opts) => spawnProcess(recoveryWorkerScript, owner, opts),
        async kill(owner) {
            const w = workers.get(owner);
            if (w) await w.kill();
        },
        async snapshot() {
            const cols = ['quotas', 'requests', 'capacity', 'users'];
            return Object.fromEntries(
                await Promise.all(cols.map(async name => [
                    name,
                    (await db.collection(`${root}/${name}`).get()).docs.map(doc => ({ id: doc.id, data: doc.data() })),
                ])),
            );
        },
        async close() {
            await Promise.all([...workers.values()].map(w => w.kill()));
            workers.clear();
        },
    };
}
