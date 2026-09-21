import { randomUUID } from 'node:crypto';
import { createSession } from './session.mjs';
import { preflight } from '../adapters/provider-contract.mjs';
import { scenarios } from '../scenarios/registry.mjs';
/** @param {Parameters<typeof preflight>[0]} input
 * @param {(event: object) => void} journal
 * @param {string} runId
 * @param {(partial: object) => void} checkpoint
 */
export async function runExperiment(input = {}, journal = () => {}, runId = randomUUID(), checkpoint = () => {}) {
    const checked = preflight(input); if (!checked.ready) throw new Error(checked.errors.join('; '));
    const { cases, limits } = checked.config; let commands = 0; const deadline = Date.now() + 50000;
    const chargeCommand = () => { if (++commands > limits.maxCommands || Date.now() > deadline) throw new Error('run-budget-exhausted'); };
    const events = []; const results = []; const assertions = []; let sequence = 0; const started = performance.now();
    for (const caseId of cases) {
        const spec = scenarios[caseId]; let caseCommands = 0;
        const chargeCaseCommand = () => { chargeCommand(); if (++caseCommands > spec.maxCommands) throw new Error('case-budget-exhausted'); };
        const record = (kind, data = {}) => { const event = { schemaVersion: 1, experimentId: 'provider-contract', runId, caseId, requestId: 'request-one', attemptId: null,
            instanceId: 'controller', localSequence: ++sequence, timestamp: new Date().toISOString(), localElapsedMs: performance.now() - started, ...data, kind }; events.push(event); journal(event); };
        let session;
        try {
            session = await createSession({ runId, caseId, record, profile: spec.profile, unsafe: spec.unsafe, maxConcurrent: spec.maxConcurrent ?? 1, chargeCommand: chargeCaseCommand });
            const outcome = await spec.run(session);
            const attempts = await session.drain();
            const finalSnapshot = await session.snapshot();
            outcome.snapshots.final = finalSnapshot;
            results.push({ caseId, status: 'complete', variantId: spec.unsafe ? 'transport-only-release' : 'terminal-evidence', commands: caseCommands, ...outcome, attempts, providerProcessId: session.provider.pid, gatewayProcessId: session.gateway.pid, observations: session.observations });
            for (const [name, expected] of Object.entries(spec.expected)) assertions.push({ caseId, name, actual: outcome[name], expected, matched: outcome[name] === expected });
        } catch (error) { results.push({ caseId, status: 'incomplete', error: 'scenario-failed' }); record('scenario-incomplete'); }
        finally { await session?.close(); }
        checkpoint({ schemaVersion: 1, run: { id: runId, selectedCases: cases, commands }, cases: results, events, assertions });
    }
    return { schemaVersion: 1, run: { id: runId, selectedCases: cases, commands }, cases: results, events, assertions };
}
