import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const experiment = 'experiments/rate-limiting/provider-contract';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function captureDefinition() {
    const sourcePaths = ['execute.mjs', 'run.mjs', 'capture-definition.mjs', 'README.md'].map(name => `${experiment}/${name}`);
    for (const dir of ['architecture', 'adapters', 'services', 'harness', 'scenarios', 'analysis', 'fixtures']) {
        for (const name of readdirSync(new URL(`./${dir}/`, import.meta.url)).sort()) {
            if (/\.(mjs|rules)$/.test(name)) sourcePaths.push(`${experiment}/${dir}/${name}`);
        }
    }
    sourcePaths.push(`${experiment}/config/local.json`, `${experiment}/config/live.example.json`);
    sourcePaths.push('experiments/shared/backends/pyric.mjs', 'experiments/shared/evidence/capture.mjs', 'experiments/shared/evidence/compare.mjs', 'experiments/rate-limiting/inference-allowance/adapters/store.mjs');
    return { experiment, sourcePaths: sourcePaths.sort(), recoverOnFailure: true,
        artifacts: ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md', 'events.ndjson', 'summary.json', 'environment.json', 'capabilities.json', 'contract-profile.json', 'provider-observations.ndjson'],
        scope: 'Provider termination contracts, gateway processes, native Pyric transactions and independent controlled provider; no application UI, credentials or cloud deployment.' };
}
export function implementationHash() {
    const root = new URL('../../../', import.meta.url);
    return digest(captureDefinition().sourcePaths.filter(path => /\.(mjs|rules)$/.test(path))
        .map(path => `${path}\0${readFileSync(new URL(path, root), 'utf8')}`).join('\0'));
}
