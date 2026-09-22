import { requestPath, hash } from '../../integrated-admission/architecture/admission.mjs';
import { refund, settle } from '../../integrated-admission/architecture/transitions.mjs';

const failure = code => Object.assign(new Error(code), { code });
const TERMINAL = ['completed', 'cancelled', 'refunded'];

/**
 * Execute the 8-row Recovery Decision Contract for a claimed reservation.
 * Every mutation re-validates (owner, fence) inside a native transaction so
 * a stale worker whose lease expired during provider observation is rejected.
 *
 * @param {object} store
 * @param {{ uid: string, requestId: string, category?: string }} request
 * @param {number} fence
 * @param {{ state: string, key?: string } | null} evidence
 * @param {{ policies: object, limits: object, budget: object, now: () => number }} options
 * @param {{ instanceId: string }} context
 */
export async function reconcile(store, request, fence, evidence, { policies, limits, budget, now }, context) {
    const reqPath = requestPath(request.uid, request.requestId);
    const current = await store.get(reqPath);
    if (!current) throw failure('missing-reservation');
    if (TERMINAL.includes(current.state)) {
        return { action: 'idempotent-terminal', record: current };
    }

    // Row 2: Reserved with no dispatch intent committed → pre-dispatch refund
    if (current.state === 'reserved') {
        const res = await refund(
            store,
            { ...request, category: current.category },
            fence,
            { policies, limits, now },
            context,
        );
        return {
            action:         'refunded-pre-dispatch',
            record:         res.record,
            creditedUnits:  res.creditedUnits,
            saturationLoss: res.saturationLoss,
        };
    }

    const evState = evidence?.state ?? 'absent';

    // Row 5: Authoritative completion or cancellation → settle & release slot once
    if (evState === 'completed' || evState === 'cancelled') {
        const settled = await settle(store, request, fence, { state: evState }, context);
        return { action: 'settled-terminal', state: evState, record: settled };
    }

    // Rows 3, 4, 6, 7: Retain slot & debit inside fenced transaction
    return store.transaction(context, async tx => {
        const record = await tx.get(reqPath);
        if (!record) throw failure('missing-reservation');
        if (TERMINAL.includes(record.state)) {
            return { action: 'idempotent-terminal', record };
        }
        if (record.owner !== context.instanceId || record.fence !== fence) {
            throw failure('stale-owner');
        }

        const attempts = (record.reconcileAttempts ?? 0) + 1;

        // Row 4: Provider reports running → reschedule with backoff
        if (evState === 'running') {
            const updated = {
                ...record,
                state:             'running',
                reconcileAttempts: attempts,
                nextCheckAt:       now() + budget.backoffMs,
                lastEvidenceRef:   evidence,
            };
            tx.put(reqPath, updated);
            return { action: 'rescheduled-running', record: updated };
        }

        // Row 6: Stop acknowledged, no termination confirmation yet
        if (evState === 'stop-pending') {
            const updated = {
                ...record,
                pendingCancel:     true,
                reconcileAttempts: attempts,
                nextCheckAt:       now() + budget.backoffMs,
                lastEvidenceRef:   evidence,
            };
            tx.put(reqPath, updated);
            return { action: 'retained-pending-cancel', record: updated };
        }

        // Row 7: Provider status transiently unavailable → retry within budget, else quarantine
        if (evState === 'unavailable') {
            if (attempts < budget.maxReconcileAttempts) {
                const updated = {
                    ...record,
                    reconcileAttempts: attempts,
                    nextCheckAt:       now() + budget.backoffMs,
                    lastEvidenceRef:   evidence,
                };
                tx.put(reqPath, updated);
                return { action: 'rescheduled-unavailable', record: updated };
            }
            const quarantined = {
                ...record,
                state:             'unknown',
                reconcileAttempts: attempts,
                quarantineReason:  'retry-budget-exhausted',
                nextCheckAt:       Number.MAX_SAFE_INTEGER,
                lastEvidenceRef:   evidence,
            };
            tx.put(reqPath, quarantined);
            return { action: 'quarantined', quarantineReason: 'retry-budget-exhausted', record: quarantined };
        }

        // Row 3: Dispatch intent recorded, provider state absent or unobservable → quarantine
        const quarantined = {
            ...record,
            state:             'unknown',
            reconcileAttempts: attempts,
            quarantineReason:  'provider-unobservable',
            nextCheckAt:       Number.MAX_SAFE_INTEGER,
            lastEvidenceRef:   evidence ?? { state: 'absent' },
        };
        tx.put(reqPath, quarantined);
        return { action: 'quarantined', quarantineReason: 'provider-unobservable', record: quarantined };
    });
}
