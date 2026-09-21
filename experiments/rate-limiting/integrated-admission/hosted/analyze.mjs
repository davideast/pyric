// Read-only analysis of two immutable captures. Writes a separate analysis record.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { verifyDeployedSource, compareSources, sharedSource } from './evidence.mjs';

const [localPath, hostedPath] = process.argv.slice(2).map(path => resolve(path));
if (!localPath || !hostedPath) throw new Error('Usage: analyze.mjs LOCAL_CAPTURE HOSTED_CAPTURE');

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha  = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = bytes => bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function load(path) {
    const manifest = await json(join(path, 'manifest.json'));
    for (const file of manifest.files) {
        if (file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Unsafe capture path');
        const bytes = await readFile(join(path, file.path));
        if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error(`Capture hash mismatch: ${file.path}`);
    }
    const result   = await json(join(path, 'result.json'));
    const attempts = rows(await readFile(join(path, 'attempts.ndjson')));
    const events   = manifest.local
        ? await json(join(path, 'server-events.json'))
        : rows(gunzipSync(await readFile(join(path, 'logs/application.ndjson.gz')))).map(row => row.entry.jsonPayload);

    const latencies = attempts.map(row => row.elapsedMs).sort((a, b) => a - b);
    const p = fraction => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
    const tx = events.filter(row => row.kind === 'transaction-attempt');
    const invocations = new Set(tx.map(row => row.invocationId));

    const state = Object.fromEntries(Object.entries(result.finalState).map(([key, value]) => [key, {
        active:       value.capacity?.find(row => row.id === 'global')?.data.active ?? 0,
        quotas:       value.quotas?.length ?? 0,
        reservations: value.requests?.length ?? 0,
        providerJobs: value.provider?.length ?? 0,
        states:       value.requests?.reduce((counts, row) => ({ ...counts, [row.data.state]: (counts[row.data.state] ?? 0) + 1 }), {}) ?? {},
    }]));

    const assessment = {
        manifestVerified:              true,
        successful:                    result.successful,
        cases:                         result.cases.length,
        assertions:                    result.assertions.length,
        recomputedAssertionsPass:      result.assertions.every(row => isDeepStrictEqual(row.actual, row.expected) && row.passed),
        commands:                      attempts.length,
        terminalTransportErrors:       attempts.filter(row => row.transportError).length,
        windowIncludesAllCompletedAttempts: attempts.every(row => row.endedAt && row.endedAt <= result.run.endedAt),
        instances:                     result.observedInstances.length,
        elapsedMs:                     Date.parse(result.run.endedAt) - Date.parse(result.run.startedAt),
        httpLatencyMs:                 { p50: p(0.5), p95: p(0.95), max: p(1) },
        transactionAttempts:           tx.length,
        transactionInvocations:        invocations.size,
        extraTransactionAttempts:      tx.length - invocations.size,
        fixtureStartAttempts:          events.filter(row => row.kind === 'fixture-provider-start-attempt').length,
        state,
    };
    return { path, result, manifestSha256: sha(await readFile(join(path, 'manifest.json'))), assessment };
}

const local      = await load(localPath);
const hosted     = await load(hostedPath);
const deployment = await json(join(hostedPath, 'deployment-report.json'));
const deployed   = await verifyDeployedSource(join(hostedPath, 'deployed-source'), deployment.sourceHash);
const architecture = await compareSources(join(localPath, 'source'), join(hostedPath, 'deployed-source'));
const workload   = await compareSources(
    join(localPath, 'source'),
    join(hostedPath, 'source'),
    ['experiments/rate-limiting/integrated-admission/hosted/workload.mjs', ...sharedSource],
);

const semantic = local.result.assertions.map(left => {
    const right = hosted.result.assertions.find(row => row.caseId === left.caseId && row.name === left.name);
    return {
        caseId: left.caseId,
        name:   left.name,
        local:  left.actual,
        hosted: right?.actual,
        match:  !!right && isDeepStrictEqual(left.actual, right.actual) && isDeepStrictEqual(left.expected, right.expected),
    };
});

const capture = await json(join(hostedPath, 'logs/capture-report.json'));
const report = {
    schemaVersion:   1,
    comparisonKind:  'paired HTTP integrated-admission workload (Pyric vs Cloud Run + Firestore)',
    createdAt:       new Date().toISOString(),
    captures:        [local, hosted].map(row => ({ path: row.path, manifestSha256: row.manifestSha256, assessment: row.assessment })),
    deployedSource:  deployed,
    architecture,
    workload,
    comparable:      architecture.identical && workload.identical
                     && local.assessment.recomputedAssertionsPass && hosted.assessment.recomputedAssertionsPass
                     && local.assessment.successful && hosted.assessment.successful
                     && semantic.length === hosted.result.assertions.length,
    matchingAssertions: semantic.filter(row => row.match).length,
    semantic,
    logging: {
        collectionStatus: capture.collectionStatus,
        coverage:         capture.coverage,
        streams:          Object.fromEntries(Object.entries(capture.streams).map(([key, value]) => [key, value.entries])),
    },
    limitations:                  hosted.result.coverage,
    productionReadinessEstablished: false,
};

const out = resolve('experiments/rate-limiting/integrated-admission/hosted/analyses', randomUUID());
await mkdir(out, { recursive: true });
await writeFile(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
await cp(new URL('./analyze.mjs', import.meta.url), join(out, 'analyze.mjs'));
await cp(new URL('./evidence.mjs', import.meta.url), join(out, 'evidence.mjs'));
const files = await Promise.all(['comparison.json', 'analyze.mjs', 'evidence.mjs'].map(async path => ({
    path, sha256: sha(await readFile(join(out, path))),
})));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');

console.log(JSON.stringify({
    out,
    comparable: report.comparable,
    matchingAssertions: report.matchingAssertions,
    local: local.assessment,
    hosted: hosted.assessment,
    logging: report.logging,
}, null, 2));

if (!report.comparable || semantic.some(row => !row.match)) process.exitCode = 1;
