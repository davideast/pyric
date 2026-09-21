import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { terminalEvidence } from '../architecture/termination-evidence.mjs';
export function durableBudget({ db, runId, limits, record }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid run namespace');
    const store = instrumentStore(db, `providerContractExperiments/${runId}`, record, { maxAttempts: 8 });
    const context = (requestId, attemptId) => ({ requestId, attemptId, instanceId: `controller-${process.pid}`, uid: 'synthetic-provider-contract-actor', phase: 'provider-contract-live' });
    return {
        async initialize() {
            return store.transaction(context(null, null), async tx => {
                if (await tx.get('state/budget')) throw new Error('Run already exists; never reset or redispatch a live run');
                tx.put('state/budget', { active: 0, dispatches: 0, releases: 0, limits, deadlineAt: Date.now() + limits.runDeadlineMs });
            });
        },
        snapshot: () => store.get('state/budget'),
        async reserve(caseId, attemptId) {
            return store.transaction(context(caseId, attemptId), async tx => {
                const state = await tx.get('state/budget'); const path = `cases/${caseId}/requests/request-one`;
                if (!state || await tx.get(path)) return false;
                if (Date.now() >= state.deadlineAt || state.active >= state.limits.maxConcurrent || state.dispatches >= state.limits.maxDispatches) return false;
                tx.put('state/budget', { ...state, active: state.active + 1, dispatches: state.dispatches + 1 });
                tx.put(path, { attemptId, state: 'unknown', released: false, providerOperationId: null });
                return true;
            });
        },
        async settle(caseId, attemptId, observation) {
            const terminal = terminalEvidence(observation);
            if (!terminal) return;
            return store.transaction(context(caseId, attemptId), async tx => {
                const state = await tx.get('state/budget'); const path = `cases/${caseId}/requests/request-one`; const request = await tx.get(path);
                if (!request || request.attemptId !== attemptId || request.released) return;
                tx.put(path, { ...request, state: terminal, released: true });
                tx.put('state/budget', { ...state, active: state.active - 1, releases: state.releases + 1 });
            });
        },
    };
}
