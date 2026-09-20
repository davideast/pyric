import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, setupVersion } from './requirements.mjs';

// The configuration snapshot is evidence, not a live assertion about a later run.
export async function recordRunObservability(directory, { backend, project, database, service = undefined, region = undefined, reportFile = undefined, requirePreflight = false, manifest }) {
    const report = { formatVersion: 1, setupVersion, manifestHash: digest(manifest), recordedAt: new Date().toISOString(),
        target: { backend, project, database, service, region }, status: 'not-checked', evidenceComplete: false,
        limitations: ['This records pre-run observability coverage, not completeness of the workload log export.'] };
    if (backend === 'local' || backend === 'pyric') report.status = 'not-applicable';
    else if (reportFile) {
        const bytes = await readFile(reportFile, 'utf8');
        const snapshot = JSON.parse(bytes);
        const sameTarget = snapshot.config?.project === project && snapshot.config?.database === database
            && (!service || (snapshot.config?.service === service && snapshot.config?.region === region));
        if (!sameTarget || snapshot.manifestHash !== digest(manifest) || snapshot.setupVersion !== setupVersion) throw new Error('Observability report target or requirements mismatch');
        const ageMs = Date.now() - Date.parse(snapshot.preflight?.finishedAt ?? snapshot.checkedAt);
        const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 3600000;
        report.status = 'incomplete';
        if (fresh && snapshot.evidenceComplete && snapshot.preflight?.status === 'passed') report.status = 'preflight-passed';
        report.snapshot = snapshot;
        report.snapshotHash = digest(snapshot);
        report.ageMs = ageMs;
        report.evidenceComplete = report.status === 'preflight-passed';
    }
    await writeFile(join(directory, 'observability-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (requirePreflight && report.status !== 'not-applicable' && !report.evidenceComplete) throw new Error('A matching observability preflight from the last hour is required');
    return report;
}
