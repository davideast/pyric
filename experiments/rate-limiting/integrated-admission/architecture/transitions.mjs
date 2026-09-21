import { COST } from '../../inference-allowance/architecture/bucket.mjs';
import { hash, quotaPath, requestPath } from './admission.mjs';

const failure = code => Object.assign(new Error(code), { code });

function assertOwner(record, owner, fence) {
    if (!record) throw failure('missing-reservation');
    if (record.owner !== owner || record.fence !== fence) throw failure('stale-owner');
}

/**
 * Transition: reserved → dispatching.
 * Records dispatch intent durably before any provider HTTP call.
 * After this, no refund is possible.
 */
export async function markDispatching(store, request, fence, context) {
    return store.transaction(context, async tx => {
        const record = await tx.get(requestPath(request.uid, request.requestId));
        assertOwner(record, context.instanceId, fence);
        if (record.state !== 'reserved') throw failure('already-dispatching');
        const next = { ...record, state: 'dispatching' };
        tx.put(requestPath(request.uid, request.requestId), next);
        return next;
    });
}

/**
 * Pre-dispatch refund.
 * Only valid when state === 'reserved' and debitState === 'debited'.
 * Atomically: releases capacity counters + refunds allowance (with saturation clamping).
 * Records saturationLoss and creditedUnits in terminalEvidence.
 * A post-dispatch record (state !== 'reserved') cannot be refunded.
 *
 * @param {object} store
 * @param {{ uid, requestId }} request
 * @param {number} fence
 * @param {{ policies, limits, now: () => number }} opts
 * @param {object} context
 */
export async function refund(store, request, fence, { policies, limits, now }, context) {
    return store.transaction(context, async tx => {
        const rPath  = requestPath(request.uid, request.requestId);
        const record = await tx.get(rPath);
        assertOwner(record, context.instanceId, fence);
        if (record.state !== 'reserved')     throw failure('not-refundable');
        if (record.debitState !== 'debited') throw failure('already-refunded');

        const qPath  = quotaPath(request.uid);
        const quota  = await tx.get(qPath);
        const global = await tx.get('capacity/global');
        const user   = await tx.get(`users/${hash(request.uid)}`);

        if (!Number.isSafeInteger(global?.active) || global.active <= 0) throw failure('invalid-counter');
        if (!Number.isSafeInteger(user?.active)   || user.active   <= 0) throw failure('invalid-counter');

        // Refund arithmetic: lazy refill at current time, then credit COST units,
        // clamped at bucket capacity. Record saturation loss separately — debits - refunds
        // alone cannot reconstruct a refilling, capped bucket balance.
        const policy    = policies[record.category];
        const capacity  = policy.capacity * COST;
        const bucket    = quota?.buckets?.[record.category];
        const effective = Math.max(now(), bucket?.updatedAt ?? now());
        const available = Math.min(capacity,
            (bucket?.remaining ?? capacity) +
            (effective - (bucket?.updatedAt ?? effective)) * policy.refillPerMinute,
        );
        const creditedUnits  = Math.min(COST, capacity - available);
        const saturationLoss = COST - creditedUnits;

        tx.put(qPath, {
            policyVersion: policies.version,
            buckets: {
                ...quota?.buckets,
                [record.category]: { remaining: available + creditedUnits, updatedAt: effective },
            },
        });
        tx.put('capacity/global',          { active: global.active - 1 });
        tx.put(`users/${hash(request.uid)}`, { active: user.active   - 1 });
        tx.put(rPath, {
            ...record,
            state:           'refunded',
            debitState:      'refunded',
            terminalEvidence: { saturationLoss, creditedUnits },
        });

        return { status: 'refunded', saturationLoss, creditedUnits };
    });
}

/**
 * Terminal settlement after confirmed provider completion or cancellation.
 * Decrements capacity counters. Never refunds allowance (post-dispatch policy, rule 4/5).
 * Idempotent: if already in a terminal state, returns existing record without re-writing.
 */
export async function settle(store, request, fence, evidence, context) {
    if (!['completed', 'cancelled'].includes(evidence.state))
        throw failure('non-terminal-evidence');

    return store.transaction(context, async tx => {
        const rPath  = requestPath(request.uid, request.requestId);
        const record = await tx.get(rPath);
        if (!record) throw failure('missing-reservation');

        // Idempotent: already settled
        if (['completed', 'cancelled'].includes(record.state)) return record;

        assertOwner(record, context.instanceId, fence);

        const global = await tx.get('capacity/global');
        const user   = await tx.get(`users/${hash(request.uid)}`);
        if (!Number.isSafeInteger(global?.active) || global.active <= 0) throw failure('invalid-counter');
        if (!Number.isSafeInteger(user?.active)   || user.active   <= 0) throw failure('invalid-counter');

        tx.put('capacity/global',          { active: global.active - 1 });
        tx.put(`users/${hash(request.uid)}`, { active: user.active   - 1 });
        tx.put(rPath, {
            ...record,
            state:           evidence.state,
            terminalEvidence: 'fixture-provider-confirmation',
        });

        return { ...record, state: evidence.state };
    });
}

/**
 * Mark slot as unknown (quarantined) — used when provider outcome is permanently uncertain.
 * Retains both the debit and the capacity slot. Does NOT release counters.
 */
export async function quarantine(store, request, fence, context) {
    return store.transaction(context, async tx => {
        const rPath  = requestPath(request.uid, request.requestId);
        const record = await tx.get(rPath);
        assertOwner(record, context.instanceId, fence);
        if (['completed', 'cancelled', 'refunded'].includes(record.state))
            throw failure('terminal-reservation');
        const next = { ...record, state: 'unknown', terminalEvidence: 'quarantined-unknown-outcome' };
        tx.put(rPath, next);
        return next;
    });
}
