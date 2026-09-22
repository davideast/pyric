import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCases } from './harness/runner.mjs';
import { scenarios } from './scenarios/registry.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { assess, summarize } from './analysis/assess.mjs';
import { RECOVERY_BUDGET } from './fixtures/contracts.mjs';

const [out, mode] = process.argv.slice(2);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const input = JSON.parse(await readFile(join(out, 'input.json'), 'utf8'));

if (input.profile !== 'local')
    throw new Error('Only local Pyric execution is implemented; Cloud Run requires explicit approval');

const ids = input.cases ?? Object.keys(scenarios);

const workload = {
    revision: 1,
    suite:    'automatic-recovery-v1',
    cases:    ids,
    budget:   RECOVERY_BUDGET,
    scenarios: Object.fromEntries(
        ids.filter(id => scenarios[id]).map(id => [id, {
            checks: scenarios[id].checks,
            expectedFailures: scenarios[id].expectedFailures ?? [],
            contractLimited: Boolean(scenarios[id].contractLimited),
        }]),
    ),
    faultModel:   'SIGKILL of gateway & recovery processes; post-commit ack loss; transient unavailability; clock skew',
    provider:     'independent host fixture oracle; observable/transient/unobservable profiles; no real inference',
    policyVersion: 'integrated-v1',
};

const rules    = await readFile(new URL('./architecture/firestore.rules', import.meta.url), 'utf8');
const metadata = {
    id:                 process.env.PYRIC_EXPERIMENT_RUN_ID,
    selectedCases:      ids,
    workloadHash:       digest(JSON.stringify(workload)),
    rulesHash:          digest(rules),
    implementationHash: implementationHash(),
    environment: {
        backend:       'pyric',
        production:    false,
        realInference: false,
        node:          process.versions.node,
        bun:           process.versions.bun ?? null,
        transport:     'separate Node gateway + recovery worker processes; IPC to shared Pyric sandbox',
        provider:      'controlled fixture oracle; observable/transient/unobservable profiles',
        transactions:  'Pyric Admin SDK; client rules bypassed',
    },
};

let result = { schemaVersion: 1, run: metadata, cases: [], events: [], assertions: [] };

if (mode === '--recover') {
    try { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    try { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
    Object.assign(result.run, { interrupted: true });
    result.cases = result.cases.map(row => ({ ...row, status: 'incomplete' }));
} else {
    await save('result.json', result);
    await writeFile(join(out, 'events.ndjson'), '');

    const completed = await runCases(
        ids,
        event => appendFileSync(join(out, 'events.ndjson'), JSON.stringify(event) + '\n'),
        metadata.id,
    );
    result = { ...completed, run: { ...completed.run, ...metadata } };
}

Object.assign(result.run, metadata);
await save('result.json', result);
await save('workload.json', workload);
await writeFile(join(out, 'firestore.rules'), rules);
await save('assessment.json', assess(result));
await save('summary.json', summarize(result));
await save('environment.json', result.run.environment);
await writeFile(join(out, 'findings.md'),
    `# Automatic recovery under competing owners\n\n` +
    `${assess(result).successfulExperiment
        ? 'All safety, conditional liveness, and completeness checks passed, including the expiry-only negative control.'
        : 'Evidence is incomplete or an outcome differs from its declared expectation.'}\n\n` +
    `See summary.json for per-case metrics, events.ndjson for worker lifecycle/query/claim/reconciliation events, ` +
    `and result.json for final snapshots and assertions.\n`,
);
