import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const experiment = 'experiments/rate-limiting/distributed-capacity';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function captureDefinition() {
    const sourcePaths = ['execute.mjs', 'run.mjs', 'capture-definition.mjs', 'README.md'].map(name => `${experiment}/${name}`);
    for (const dir of ['architecture', 'adapters', 'services', 'harness', 'scenarios', 'analysis']) {
        for (const name of readdirSync(new URL(`./${dir}/`, import.meta.url)).sort()) {
            if (/\.(mjs|rules)$/.test(name)) sourcePaths.push(`${experiment}/${dir}/${name}`);
        }
    }
    sourcePaths.push('experiments/shared/backends/pyric.mjs', 'experiments/shared/evidence/capture.mjs', 'experiments/shared/evidence/compare.mjs', 'experiments/rate-limiting/inference-allowance/adapters/store.mjs');
    return { experiment, sourcePaths: sourcePaths.sort(), recoverOnFailure: true,
        artifacts: ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md', 'events.ndjson', 'summary.json', 'environment.json'],
        scope: 'Distributed execution capacity, gateway processes, native Pyric transactions and independent simulated provider; no application UI, credentials or cloud deployment.' };
}
export function implementationHash() {
    const root = new URL('../../../', import.meta.url);
    return digest(captureDefinition().sourcePaths.filter(path => /\.(mjs|rules)$/.test(path))
        .map(path => `${path}\0${readFileSync(new URL(path, root), 'utf8')}`).join('\0'));
}
