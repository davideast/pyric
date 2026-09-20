// Operator-only endpoint behind the same Cloud Run IAM boundary as the harness.
// It does not touch allowance records or dispatch inference.
export function mountObservabilityPreflight(app, { db, project, database, record }) {
    app.post('/observability/preflight', async (req, res) => {
        const { probeId, database: requestedDatabase } = req.body ?? {};
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(probeId ?? '') || requestedDatabase !== database) {
            return res.status(400).json({ error: 'Invalid preflight target' });
        }
        const ref = db.doc(`observabilityPreflight/${probeId}`);
        const documentName = `projects/${project}/databases/${database}/documents/${ref.path}`;
        let created = false, cleanedUp = false, readBack = false;
        record('observability-preflight-start', { probeId, documentName });
        try {
            await db.runTransaction(async tx => {
                if ((await tx.get(ref)).exists) throw new Error('Canary already exists');
                tx.set(ref, { probeId, purpose: 'logging-preflight', createdAt: new Date().toISOString() });
            });
            created = true;
            const snapshot = await ref.get();
            readBack = snapshot.data()?.probeId === probeId;
        } catch {
            record('observability-preflight-error', { probeId, documentName, phase: 'read-write' });
        } finally {
            if (created) {
                try { await ref.delete(); cleanedUp = true; }
                catch { record('observability-preflight-error', { probeId, documentName, phase: 'cleanup' }); }
            }
        }
        if (!readBack || !cleanedUp) return res.status(500).json({ probeId, documentName, cleanedUp });
        record('observability-preflight-complete', { probeId, documentName, cleanedUp });
        return res.json({ probeId, documentName, cleanedUp });
    });
}
