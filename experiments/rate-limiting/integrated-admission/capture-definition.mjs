import { readdirSync, readFileSync } from 'node:fs';
import { createHash }               from 'node:crypto';

export const EXPERIMENT   = 'experiments/rate-limiting/integrated-admission';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function captureDefinition() {
    const sourcePaths = ['execute.mjs', 'run.mjs', 'capture-definition.mjs', 'README.md']
        .map(name => `${EXPERIMENT}/${name}`);

    for (const dir of ['architecture', 'adapters', 'services', 'harness', 'scenarios', 'analysis', 'fixtures']) {
        try {
            for (const name of readdirSync(new URL(`./${dir}/`, import.meta.url)).sort()) {
                if (/\.(mjs|rules)$/.test(name)) sourcePaths.push(`${EXPERIMENT}/${dir}/${name}`);
            }
        } catch { /* directory may not exist yet during preflight */ }
    }
    sourcePaths.push(`${EXPERIMENT}/config/local.json`);

    // Shared infrastructure reused across experiments (not copied)
    sourcePaths.push(
        'experiments/shared/backends/pyric.mjs',
        'experiments/shared/evidence/capture.mjs',
        'experiments/shared/evidence/compare.mjs',
        'experiments/rate-limiting/inference-allowance/architecture/bucket.mjs',
        'experiments/rate-limiting/inference-allowance/adapters/store.mjs',
        'experiments/rate-limiting/distributed-capacity/architecture/capacity.mjs',
        'experiments/rate-limiting/provider-contract/fixtures/capabilities.mjs',
        'experiments/rate-limiting/provider-contract/fixtures/contract-profile.mjs',
    );

    return {
        experiment:       EXPERIMENT,
        sourcePaths:      sourcePaths.sort(),
        recoverOnFailure: true,
        artifacts: [
            'result.json', 'assessment.json', 'workload.json',
            'firestore.rules', 'findings.md', 'events.ndjson',
            'summary.json', 'environment.json',
        ],
        scope: 'Integrated allowance+capacity admission, gateway processes, native Pyric transactions, ' +
               'independent fixture oracle; no application UI, credentials, real AI calls, or cloud deployment.',
    };
}

export function implementationHash() {
    const root = new URL('../../../', import.meta.url);
    return digest(
        captureDefinition().sourcePaths
            .filter(path => /\.(mjs|rules)$/.test(path))
            .map(path => {
                try { return `${path}\0${readFileSync(new URL(path, root), 'utf8')}`; }
                catch { return ''; }   // missing shared files don't break preflight hash
            })
            .join('\0'),
    );
}
