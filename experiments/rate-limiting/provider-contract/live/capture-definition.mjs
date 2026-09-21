import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const experiment = 'experiments/rate-limiting/provider-contract/live';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function captureDefinition() {
    const sourcePaths = readdirSync(new URL('./', import.meta.url)).filter(n => /\.(mjs|md)$/.test(n)).map(n => `${experiment}/${n}`);
    sourcePaths.push(...['adapters/ai-logic.mjs', 'architecture/termination-evidence.mjs', 'architecture/firestore.rules', 'fixtures/capabilities.mjs', 'fixtures/contract-profile.mjs'].map(p => `experiments/rate-limiting/provider-contract/${p}`),
        'experiments/rate-limiting/inference-allowance/adapters/store.mjs', 'experiments/shared/observability/google-api.mjs', 'experiments/shared/observability/log-scope.mjs', 'experiments/shared/observability/log-redaction.mjs', 'experiments/shared/evidence/capture.mjs');
    return { experiment, sourcePaths: sourcePaths.sort(), replayAllowed: false, executionTimeoutMs: 240000, recoverOnFailure: true,
        artifacts: ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md', 'events.ndjson', 'attempts.ndjson', 'snapshots.json', 'environment.json', 'capabilities.json', 'contract-profile.json'],
        scope: 'Local controller using real Firebase AI Logic and dedicated Firestore; no Cloud Run deployment; no credentials or model text captured; live replay prohibited' };
}
export function implementationHash() {
    const root = new URL('../../../../', import.meta.url);
    return digest(captureDefinition().sourcePaths.filter(p => p.endsWith('.mjs') || p.endsWith('.rules')).map(p => p + '\0' + readFileSync(new URL(p, root), 'utf8')).join('\0'));
}
