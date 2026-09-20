import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export const experiment = 'experiments/rate-limiting/inference-allowance';
const root = fileURLToPath(new URL('./', import.meta.url));
export function captureDefinition() {
    const paths = [];
    for (const dir of ['architecture', 'adapters', 'services', 'fixtures', 'scenarios', 'scenarios/provider-lifecycle', 'harness', 'analysis', 'config', 'deployment']) {
        for (const file of readdirSync(join(root, dir)).sort())
            if ((/\.(mjs|rules|json)$/.test(file) || file === 'Dockerfile.cloudrun') && !file.includes('.local.') && (dir !== 'config' || ['local.json', 'http-overload.json', 'inference-concurrency.json', 'provider-lifecycle.json', 'firestore.example.json', 'production.example.json'].includes(file)))
                paths.push(`${experiment}/${dir}/${file}`);
    }
    paths.push('experiments/shared/backends/pyric.mjs');
    for (const file of readdirSync(new URL('../../shared/observability/', import.meta.url)).sort())
        if (file.endsWith('.mjs')) paths.push(`experiments/shared/observability/${file}`);
    paths.push(`${experiment}/observability.json`, `${experiment}/setup-observability.mjs`, `${experiment}/OBSERVABILITY.md`);
    paths.push(...['execute.mjs', 'run.mjs', 'capture-definition.mjs', 'INFERENCE-CONCURRENCY.md', 'PROVIDER-LIFECYCLE.md', 'HOSTED-EXECUTION.md', 'README.md'].map(p => `${experiment}/${p}`));
    return { experiment, recoverOnFailure: true, sourcePaths: paths.sort(), artifacts: ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md', 'events.ndjson', 'summary.json', 'environment.json', 'observability-report.json'], scope: 'Extracted inference admission architecture, synthetic fixtures and harness. No credentials, app data or dependency binaries.' };
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function implementationHash() {
    return digest(captureDefinition().sourcePaths.filter(p => !p.includes('/config/')).map(p => `${p}\0${readFileSync(join(fileURLToPath(new URL('../../../', import.meta.url)), p), 'utf8')}`).join('\0'));
}
