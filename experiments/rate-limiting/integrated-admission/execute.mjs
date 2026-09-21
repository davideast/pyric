import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync }     from 'node:fs';
import { join }               from 'node:path';
import { runCases }           from './harness/run-cases.mjs';
import { scenarios }          from './scenarios/registry.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { assess, summarize }  from './analysis/assess.mjs';

const [out, mode] = process.argv.slice(2);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const input = JSON.parse(await readFile(join(out, 'input.json'), 'utf8'));

if (input.profile !== 'local')
    throw new Error('Only local Pyric execution is implemented; Cloud Run requires explicit approval');

const ids = input.cases ?? Object.keys(scenarios);

const workload = {
    revision: 1,
    suite:    'integrated-admission-v1',
    cases:    ids,
    scenarios: Object.fromEntries(
        ids.filter(id => scenarios[id]).map(id => [id, { checks: scenarios[id].checks, expectedFailures: scenarios[id].expectedFailures ?? [] }]),
    ),
    faultModel:   'SIGKILL at named barriers; injected post-commit acknowledgement loss; controlled time advances',
    provider:     'independent host fixture oracle; observable profile; no real inference',
    policyVersion: 'integrated-v1',
};

const rules    = await readFile(new URL('./architecture/firestore.rules', import.meta.url), 'utf8');
const metadata = {
    id:                  process.env.PYRIC_EXPERIMENT_RUN_ID,
    selectedCases:       ids,
    workloadHash:        digest(JSON.stringify(workload)),
    rulesHash:           digest(rules),
    implementationHash:  implementationHash(),
    environment: {
        backend:      'pyric',
        production:   false,
        realInference: false,
        node:         process.versions.node,
        bun:          process.versions.bun ?? null,
        transport:    'separate Node gateway processes; IPC to shared in-process Pyric sandbox',
        provider:     'controlled fixture oracle; observable profile',
        transactions: 'Pyric Admin SDK; client rules bypassed',
    },
};

let result = { schemaVersion: 1, run: metadata, cases: [], events: [], assertions: [] };

if (mode === '--recover') {
    try   { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    try   { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
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
    `# Integrated admission and accounting\n\n` +
    `${assess(result).successfulExperiment
        ? 'The declared checks had their expected outcomes, including the split-admission negative control.'
        : 'Evidence is incomplete or an outcome differs from its declared expectation.'}\n\n` +
    `See summary.json for each case, events.ndjson for transaction/process/provider observations, ` +
    `and result.json for final state and assertions.\n\n` +
    `This is local Pyric evidence, not a Firestore throughput or real-provider termination guarantee. ` +
    `No Cloud Run deployment was performed. Real inference was not used.\n`,
);
