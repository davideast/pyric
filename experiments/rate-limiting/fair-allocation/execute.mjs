import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAllScenarios } from './harness/runner.mjs';
import { scenarios } from './scenarios/registry.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { assess, summarize } from './analysis/assess.mjs';
import { LIMITS, QUEUE_LIMITS, POLICIES, VARIANTS } from './fixtures/workloads.mjs';

const [out, mode] = process.argv.slice(2);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const input = JSON.parse(await readFile(join(out, 'input.json'), 'utf8'));

if (input.profile !== 'local')
    throw new Error('Only local Pyric execution is implemented; Cloud Run requires explicit approval');

const ids = input.cases ?? Object.keys(scenarios);

const workload = {
    revision:    1,
    suite:       'fair-allocation-v1',
    cases:       ids,
    variants:    VARIANTS,
    limits:      LIMITS,
    queueLimits: QUEUE_LIMITS,
    policies:    POLICIES,
    scenarios:   Object.fromEntries(
        ids.filter(id => scenarios[id]).map(id => [id, {
            checks:           scenarios[id].checks,
            expectedFailures: scenarios[id].expectedFailures ?? [],
        }]),
    ),
    provider:      'independent host fixture oracle; seeded durations; no real inference',
    policyVersion: POLICIES.version,
};

const rules = await readFile(new URL('./architecture/firestore.rules', import.meta.url), 'utf8');
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
        transport:     'Pyric sandbox with independent provider oracle',
        provider:      'controlled fixture oracle; seeded 200ms / 1000ms durations',
        transactions:  'Pyric Admin SDK; client rules bypassed',
    },
};

let result = { schemaVersion: 1, run: metadata, cases: [], events: [], assertions: [] };

if (mode === '--recover') {
    try { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    Object.assign(result.run, { interrupted: true });
    result.cases = result.cases.map(row => ({ ...row, status: 'incomplete' }));
} else {
    const completed = await runAllScenarios({ caseIds: ids });
    result = { ...completed, run: metadata };
}

const assessment = assess(result);
const findings = [
    '# Findings — Experiment 9: Fair Allocation Under Contention',
    '',
    `- **Safety Invariants Preserved:** \`${assessment.safety}\``,
    `- **Schedule Fidelity:** \`${assessment.scheduleFidelity}\``,
    `- **Evidence Completeness:** \`${assessment.evidenceCompleteness}\``,
    `- **Scenarios Verified:** \`${assessment.cases}\` cases, \`${assessment.assertions}\` assertions (\`${assessment.expectedControlFailures}\` negative control failure verified)`,
    `- **Variants Compared:** \`${VARIANTS.join('`, `')}\` under global limit \`${LIMITS.global}\`, per-user cap \`${LIMITS.perUser}\`, queue bounds \`${QUEUE_LIMITS.global}\` global / \`${QUEUE_LIMITS.perUser}\` per user.`,
].join('\n') + '\n';

await save('result.json', result);
await save('workload.json', workload);
await writeFile(join(out, 'firestore.rules'), rules);
await save('assessment.json', assessment);
await save('summary.json', summarize(result));
await save('environment.json', result.run.environment);
await writeFile(join(out, 'findings.md'), findings);
await writeFile(
    join(out, 'events.ndjson'),
    result.events.map(e => JSON.stringify(e)).join('\n') + '\n',
);
