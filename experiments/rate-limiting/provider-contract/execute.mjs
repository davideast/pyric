import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExperiment } from './harness/runner.mjs';
import { preflight } from './adapters/provider-contract.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { assess, summarize } from './analysis/assess.mjs';
import { fixtureVersion, providerCapabilities } from './fixtures/capabilities.mjs';
import { scenarios } from './scenarios/registry.mjs';
import { contractProfile } from './fixtures/contract-profile.mjs';
import { pyricBackend } from '../../shared/backends/pyric.mjs';
const [out, mode] = process.argv.slice(2);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const checked = preflight(JSON.parse(await readFile(join(out, 'input.json'), 'utf8')));
if (!checked.ready) throw new Error(checked.errors.join('; '));
const config = checked.config;
const workload = { revision: 1, fixtureVersion, seed: null, clock: 'process-monotonic; cross-process durations prohibited',
    scenarios: Object.fromEntries(config.cases.map(id => [id, { profile: scenarios[id].profile, checks: scenarios[id].expected, maxCommands: scenarios[id].maxCommands, maxTransactionAttempts: scenarios[id].maxTransactionAttempts }])), ...config, policy: 'terminal-evidence-v1', faultModel: 'independent provider process, gateway SIGKILL, explicit transport aborts, controlled terminal ordering' };
const rules = await readFile(new URL('./architecture/firestore.rules', import.meta.url), 'utf8');
const policyHash = digest(await readFile(new URL('./architecture/termination-evidence.mjs', import.meta.url), 'utf8') + await readFile(new URL('./harness/session.mjs', import.meta.url), 'utf8'));
const metadata = { workloadVersion: 1, fixtureVersion, policyHash, pairedRunId: null, variantId: 'declared-per-case', id: process.env.PYRIC_EXPERIMENT_RUN_ID, selectedCases: config.cases, workloadHash: digest(JSON.stringify(workload)), rulesHash: digest(rules), implementationHash: implementationHash(),
    environment: { ...pyricBackend.environment, node: process.versions.node, bun: process.versions.bun ?? null, provider: 'controlled HTTP fixture', gateway: 'Node child process; controller IPC ingress', transactions: 'Pyric Admin SDK; client rules bypassed', realInference: false } };
let result = { schemaVersion: 1, run: metadata, cases: [], events: [], assertions: [] };
if (mode === '--recover') {
    try { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    try { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
    result.run = { ...metadata, interrupted: true };
} else {
    await save('result.json', result); await writeFile(join(out, 'events.ndjson'), '');
    const completed = await runExperiment(config, event => appendFileSync(join(out, 'events.ndjson'), JSON.stringify(event) + '\n'), metadata.id,
        partial => writeFileSync(join(out, 'result.json'), JSON.stringify({ ...partial, run: metadata })));
    result = { ...completed, run: { ...completed.run, ...metadata } };
}
await save('snapshots.json', result.cases.map(c => ({ caseId: c.caseId, snapshots: c.snapshots ?? null })));
await writeFile(join(out, 'attempts.ndjson'), result.events.filter(e => ['dispatch-intent', 'attempt-settled'].includes(e.kind)).map(e => JSON.stringify(e)).join('\n') + '\n');
await save('result.json', result); await save('workload.json', workload); await writeFile(join(out, 'firestore.rules'), rules);
await save('assessment.json', assess(result)); await save('summary.json', summarize(result)); await save('environment.json', metadata.environment);
await save('capabilities.json', providerCapabilities); await save('contract-profile.json', contractProfile);
await writeFile(join(out, 'provider-observations.ndjson'), result.events.filter(e => ['provider-observation', 'oracle-snapshot'].includes(e.kind)).map(e => JSON.stringify(e)).join('\n') + '\n');
await writeFile(join(out, 'findings.md'), `# Provider contract\n\n${assess(result).successfulExperiment ? 'All declared outcomes matched, including the intentional unsafe-control failure.' : 'Run incomplete or unexpected outcomes; do not treat as passing evidence.'}\n\nSee result.json and events.ndjson for correlated gateway, store and provider observations. Provider oracle state is independent of gateway decisions. Local controlled evidence only; real AI Logic termination semantics remain untested.\n`);
