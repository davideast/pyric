import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { mountObservabilityPreflight } from '../services/observability-preflight.mjs';

test('preflight uses the public sandbox API to create, read and clean up only its canary', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox.withAuth(null));
    await db.doc('allowanceExperiments/existing').set({ preserved: true });
    const events = [];
    const app = express(); app.use(express.json());
    mountObservabilityPreflight(app, { db, project: 'test-project', database: 'test-db', record: (kind, data) => events.push({ kind, ...data }) });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server');
    const post = (body) => fetch(`http://127.0.0.1:${address.port}/observability/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const probeId = randomUUID();
        const response = await post({ probeId, database: 'test-db' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ probeId, documentName: `projects/test-project/databases/test-db/documents/observabilityPreflight/${probeId}`, cleanedUp: true });
        expect((await db.doc(`observabilityPreflight/${probeId}`).get()).exists).toBe(false);
        expect((await db.doc('allowanceExperiments/existing').get()).data()).toEqual({ preserved: true });
        expect(events.map(e => e.kind)).toEqual(['observability-preflight-start', 'observability-preflight-complete']);
        expect((await post({ probeId: '../escape', database: 'test-db' })).status).toBe(400);
        expect((await post({ probeId: randomUUID(), database: 'wrong-db' })).status).toBe(400);
        const collision = randomUUID();
        await db.doc(`observabilityPreflight/${collision}`).set({ preserved: true });
        expect((await post({ probeId: collision, database: 'test-db' })).status).toBe(500);
        expect((await db.doc(`observabilityPreflight/${collision}`).get()).data()).toEqual({ preserved: true });
    } finally { await new Promise(resolve => server.close(resolve)); }
});
