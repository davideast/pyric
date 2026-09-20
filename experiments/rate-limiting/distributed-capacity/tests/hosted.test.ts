import { test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { createHostedCapacityApp } from '../hosted/http-app.mjs';
import { prepareCloudRun } from '../deployment/prepare.mjs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

async function hosted(instanceId: string, db = getAdminFirestore(initializeSandbox().withAuth(null))) {
    const events: any[] = [];
    const service = createHostedCapacityApp({ db, instanceId, runId: 'test-run', record: (kind, data) => events.push({ kind, ...data }),
        environment: { backend: 'pyric', production: false, sourceHash: 'test-source', revision: 'local-test' } });
    const server = service.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No HTTP listener');
    const url = `http://127.0.0.1:${address.port}`;
    return { db, events, url, service, async command(caseId: string, body: object) {
        const response = await fetch(`${url}/cases/${caseId}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }, async close() { service.stopAdmission(); await new Promise<void>(resolve => server.close(() => resolve())); await service.drain(); } };
}

test('hosted deployment smoke exercises real SDK transactions and persists a terminal fake operation', async () => {
    const host = await hosted('instance-a');
    try {
        const health = await (await fetch(`${host.url}/health`)).json();
        expect(health.sourceHash).toBe('test-source');
        expect(health.inference).toBe('durable fixture; no real model calls');
        const smoke = await host.command('deployment-smoke', { operation: 'smoke', uid: 'alice', requestId: 'deploy-smoke' });
        expect(smoke.status).toBe(200);
        expect(smoke.body.result.record.state).toBe('completed');
        const state = await host.command('deployment-smoke', { operation: 'inspect' });
        expect(state.body.result.capacity[0].data.active).toBe(0);
        expect(state.body.result.provider[0].data.state).toBe('completed');
        expect(host.events.some(row => row.kind === 'transaction-acknowledged')).toBe(true);
        expect((await host.command('deployment-smoke', { operation: 'smoke', uid: 'alice', requestId: 'deploy-smoke' })).body.result.status).toBe('duplicate');
    } finally { await host.close(); }
});

test('independent HTTP gateways share capacity, retain orphaned work and fence recovery using public sandbox transactions', async () => {
    const a = await hosted('instance-a'), b = await hosted('instance-b', a.db);
    try {
        const request = { uid: 'alice', requestId: 'orphan', logicalTimeMs: 1000 };
        const start = await a.command('recovery', { ...request, operation: 'start' });
        expect(start.status).toBe(200);
        expect(start.body.result.record.state).toBe('running');
        const reclaimed = await b.command('recovery', { ...request, logicalTimeMs: 32000, operation: 'takeover' });
        expect(reclaimed.body.result.fence).toBe(2);
        expect(reclaimed.body.result.owner).toBe('instance-b');
        const stale = await a.command('recovery', { ...request, logicalTimeMs: 32000, operation: 'reconcile', fence: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe('stale-owner');
        await b.command('recovery', { ...request, operation: 'provider-finish', outcome: 'completed' });
        const terminal = await b.command('recovery', { ...request, logicalTimeMs: 32000, operation: 'reconcile', fence: 2 });
        expect(terminal.body.result.state).toBe('completed');
        const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).command('capacity-shared', {
            operation: 'start', uid: i % 2 ? 'alice' : 'bob', requestId: `parallel-${i}`, logicalTimeMs: 1000,
        })));
        expect(responses.filter(row => row.body.result?.status === 'started')).toHaveLength(3);
        const state = (await a.command('capacity-shared', { operation: 'inspect' })).body.result;
        expect(state.capacity[0].data.active).toBe(3);
        expect(Math.max(...state.users.map(row => row.data.active))).toBe(2);
        expect(state.provider).toHaveLength(3);
    } finally { await a.close(); await b.close(); }
});

test('deployment package runs the capacity gateway and contains only pinned harness dependencies', async () => {
    const prepared = await prepareCloudRun();
    try {
        const pkg = JSON.parse(await readFile(join(prepared.directory, 'package.json'), 'utf8'));
        expect(pkg.scripts.start).toBe('node experiments/rate-limiting/distributed-capacity/hosted/entry.mjs');
        expect(pkg.dependencies).toEqual({ express: '5.2.1', 'firebase-admin': '13.10.0' });
        const lock = JSON.parse(await readFile(join(prepared.directory, 'package-lock.json'), 'utf8'));
        expect(lock.name).toBe(pkg.name);
        expect(lock.packages[''].name).toBe(pkg.name);
        const files = await readdir(prepared.directory, { recursive: true });
        expect(files.some(path => /digame-mas|\.env|results|node_modules/.test(path))).toBe(false);
        expect(prepared.files).toContain('experiments/rate-limiting/distributed-capacity/architecture/capacity.mjs');
        expect(prepared.files).not.toContain('experiments/rate-limiting/distributed-capacity/architecture/unsafe-expiry.mjs');
    } finally { await rm(prepared.directory, { recursive: true, force: true }); }
});

test('bounded hosted workload validates capacity and recovery through public HTTP over Pyric', async () => {
    const { runHostedWorkload } = await import('../hosted/workload.mjs');
    const host = await hosted('instance-a');
    try {
        const result = await runHostedWorkload({ measurementId: 'test-measurement', command: host.command });
        expect(result.cases).toHaveLength(9);
        expect(result.cases.every(row => row.status === 'passed')).toBe(true);
        expect(result.assertions.length).toBeGreaterThan(30);
        expect(result.assertions.every(row => row.passed)).toBe(true);
        expect(result.finalState['capacity-shared'].capacity[0].data.active).toBe(0);
        expect(result.finalState.recovery.capacity[0].data.active).toBe(3);
        expect(result.commands).toBeLessThan(200);
        expect(result.coverage.actualProcessCrashTested).toBe(false);
    } finally { await host.close(); }
});

test('hosted controller waits for every dispatched response before recording a failed batch', async () => {
    const { runHostedWorkload } = await import('../hosted/workload.mjs');
    const host = await hosted('instance-a');
    let finished = 0;
    try {
        const result = await runHostedWorkload({ measurementId: 'transport-fault', command: async (space, body) => {
            const response = await host.command(space, body);
            if (body.operation === 'start') {
                if (body.requestId.endsWith('parallel-0')) throw new Error('simulated lost HTTP acknowledgment');
                await new Promise(resolve => setTimeout(resolve, 50));
                finished++;
            }
            return response;
        } });
        expect(finished).toBe(15);
        expect(result.successful).toBe(false);
        expect(result.cases[0].status).toBe('incomplete');
    } finally { await host.close(); }
});

test('hosted controller cannot report success without its final ledger snapshots', async () => {
    const { runHostedWorkload } = await import('../hosted/workload.mjs');
    const host = await hosted('instance-a');
    let cases = 0;
    try {
        const result = await runHostedWorkload({ measurementId: 'final-read-fault', onCase: () => { cases++; }, command: async (space, body) => {
            if (cases === 9 && body.operation === 'inspect') throw new Error('final snapshot unavailable');
            return host.command(space, body);
        } });
        expect(result.assertions.every(row => row.passed)).toBe(true);
        expect(result.successful).toBe(false);
        expect(result.failure).toContain('Final state');
    } finally { await host.close(); }
});

test('hosted workload rejects a deployment archive whose source changed after packaging', async () => {
    const { verifyDeployedSource } = await import('../hosted/evidence.mjs');
    const { writeFile } = await import('node:fs/promises');
    const prepared = await prepareCloudRun();
    try {
        expect((await verifyDeployedSource(prepared.directory, prepared.sourceHash)).verified).toBe(true);
        await writeFile(join(prepared.directory, 'package.json'), '{}');
        await expect(verifyDeployedSource(prepared.directory, prepared.sourceHash)).rejects.toThrow('Source hash mismatch');
    } finally { await rm(prepared.directory, { recursive: true, force: true }); }
});
