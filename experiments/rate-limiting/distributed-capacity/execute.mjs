import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCases } from './harness/run-cases.mjs';
import { scenarios } from './harness/scenarios.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { assess, summarize } from './analysis/assess.mjs';
const [out, mode] = process.argv.slice(2);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const input = JSON.parse(await readFile(join(out, 'input.json'), 'utf8'));
if (input.profile !== 'local') throw new Error('Only local Pyric execution is implemented; Cloud Run requires explicit approval');
const ids = input.cases ?? Object.keys(scenarios);
const workload = { revision: 1, suite: 'distributed-execution-capacity-recovery', cases: ids,
    scenarios: Object.fromEntries(ids.filter(id => scenarios[id]).map(id => [id, { limits: scenarios[id].limits, checks: scenarios[id].checks, expectedFailures: scenarios[id].expectedFailures ?? [] }])),
    faultModel: 'SIGKILL at named barriers; injected post-commit acknowledgement loss; controlled time advances',
    provider: 'independent host fixture; observable status can be hidden; no real inference' };
const rules = await readFile(new URL('./architecture/firestore.rules', import.meta.url), 'utf8');
const metadata = { id: process.env.PYRIC_EXPERIMENT_RUN_ID, selectedCases: ids, workloadHash: digest(JSON.stringify(workload)), rulesHash: digest(rules), implementationHash: implementationHash() };
let result = { schemaVersion: 2, run: metadata, cases: [], events: [], assertions: [] };
if (mode === '--recover') {
    try { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    try { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
    Object.assign(result.run, { interrupted: true, environment: { backend: 'pyric', production: false, limitations: ['Interrupted capture; missing observations remain unknown'] } });
    result.cases = result.cases.map(row => ({ ...row, status: 'incomplete' }));
} else {
    await save('result.json', result);
    await writeFile(join(out, 'events.ndjson'), '');
    const completed = await runCases(ids, event => appendFileSync(join(out, 'events.ndjson'), JSON.stringify(event) + '\n'), metadata.id);
    result = { ...completed, run: { ...completed.run, ...metadata } };
}
Object.assign(result.run, metadata);
await save('result.json', result);
await save('workload.json', workload);
await writeFile(join(out, 'firestore.rules'), rules);
await save('assessment.json', assess(result));
await save('summary.json', summarize(result));
await save('environment.json', result.run.environment);
await writeFile(join(out, 'findings.md'), `# Distributed execution capacity and recovery\n\n${assess(result).successfulExperiment ? 'The declared checks had their expected outcomes, including the unsafe control failures.' : 'Evidence is incomplete or an outcome differs from its declared expectation.'}\n\nSee summary.json for each case, events.ndjson for transaction/process/provider observations and result.json for final state and assertions.\n\nThis is local Pyric evidence, not a Firestore throughput or real-provider termination guarantee. No Cloud Run deployment was performed.\n`);
