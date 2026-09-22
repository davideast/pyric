import { POLICIES, LIMITS } from '../../integrated-admission/fixtures/policy.mjs';

export { POLICIES, LIMITS };

export const RECOVERY_BUDGET = {
    pageSize:             3,
    maxScanPages:         5,
    maxReconcileAttempts: 3,
    backoffMs:            2_000,
    leaseMs:              10_000,
    preDispatchPolicy:    'refund',   // 'refund' | 'resume'
};

export const EVIDENCE_PROFILES = {
    observable: {
        id: 'observable',
        description: 'Provider exposes authoritative running/completed/cancelled states.',
    },
    transientlyUnavailable: {
        id: 'transiently-unavailable',
        description: 'Provider status endpoint returns temporary errors before recovering.',
    },
    stopPending: {
        id: 'stop-pending',
        description: 'Provider acknowledges stop request before confirming actual termination.',
    },
    foreverUnobservable: {
        id: 'forever-unobservable',
        description: 'Provider exposes no operation-status API or terminal confirmation (AI Logic profile).',
    },
};
