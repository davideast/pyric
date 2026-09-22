import { consume } from '../../inference-allowance/architecture/bucket.mjs';
import { hash, requestPath, quotaPath, providerKey } from '../../integrated-admission/architecture/admission.mjs';
import { queuePath, queueUserPath, queueGlobalPath } from './queue.mjs';

/**
 * Deterministic global FIFO selector.
 * Orders queued candidates by (enqueueSeq ASC, requestId ASC), re-verifies queue state
 * and TTL inside an atomic transaction, checks per-user and global execution caps,
 * debits allowance, decrements pending queue counters, and transitions directly to
 * `dispatching` with a fenced lease.
 */
export async function selectNextFifo(store, candidates, { limits, policies, owner, now }, context) {
    const ordered = [...candidates]
        .filter(c => c.state === 'queued')
        .sort((a, b) => {
            const diff = (a.enqueueSeq ?? 0) - (b.enqueueSeq ?? 0);
            if (diff !== 0) return diff;
            return String(a.requestId).localeCompare(String(b.requestId));
        });

    if (ordered.length === 0) return { status: 'empty', record: null };

    return store.transaction(context, async tx => {
        const ts = now();
        const globalCap = (await tx.get('capacity/global')) ?? { active: 0 };
        if (globalCap.active >= limits.global) {
            return { status: 'capacity-full', record: null };
        }

        const globalQueue = (await tx.get(queueGlobalPath)) ?? { pending: 0, seq: 0 };

        for (const cand of ordered) {
            const qPath = queuePath(cand.uid, cand.requestId);
            const qRec = await tx.get(qPath);
            if (!qRec || qRec.state !== 'queued') continue;

            const uQueuePath = queueUserPath(cand.uid);
            const uQueue = (await tx.get(uQueuePath)) ?? { pending: 1 };

            if (qRec.expiresAt <= ts) {
                tx.put(qPath, { ...qRec, state: 'expired' });
                tx.put(queueGlobalPath, { ...globalQueue, pending: Math.max(0, globalQueue.pending - 1) });
                tx.put(uQueuePath, { pending: Math.max(0, uQueue.pending - 1) });
                return { status: 'expired', record: qRec };
            }

            const uCapPath = `users/${hash(cand.uid)}`;
            const uCap = (await tx.get(uCapPath)) ?? { active: 0 };
            if (uCap.active >= limits.perUser) {
                continue;
            }

            const qtaPath = quotaPath(cand.uid);
            const qtaDoc = (await tx.get(qtaPath)) ?? { policyVersion: policies.version, buckets: {} };
            const category = cand.category ?? 'chat';
            const debited = consume(qtaDoc.buckets?.[category], policies[category], ts);

            if (!debited.allowed) {
                const deniedQueue = { ...qRec, state: 'quota-denied', decidedAt: ts };
                tx.put(qPath, deniedQueue);
                tx.put(queueGlobalPath, { ...globalQueue, pending: Math.max(0, globalQueue.pending - 1) });
                tx.put(uQueuePath, { pending: Math.max(0, uQueue.pending - 1) });
                return { status: 'quota-denied', record: deniedQueue };
            }

            const reqPath = requestPath(cand.uid, cand.requestId);
            const pKey = providerKey(cand.uid, cand.requestId);
            const reqRecord = {
                uid:              cand.uid,
                requestId:        cand.requestId,
                category,
                model:            cand.model ?? 'fake',
                payloadHash:      cand.payloadHash,
                durationMs:       cand.durationMs ?? 200,
                providerKey:      pKey,
                policyVersion:    policies.version,
                owner,
                fence:            1,
                leaseUntil:       ts + limits.leaseMs,
                state:            'dispatching',
                debitState:       'debited',
                enqueuedAt:       qRec.enqueuedAt,
                admittedAt:       ts,
                queueWaitMs:      Math.max(0, ts - qRec.enqueuedAt),
                terminalEvidence: null,
            };

            const selectedQueue = {
                ...qRec,
                state:      'selected',
                selectedAt: ts,
                selectedBy: owner,
            };

            tx.put(qPath, selectedQueue);
            tx.put(queueGlobalPath, { ...globalQueue, pending: Math.max(0, globalQueue.pending - 1) });
            tx.put(uQueuePath, { pending: Math.max(0, uQueue.pending - 1) });
            tx.put(qtaPath, {
                policyVersion: policies.version,
                buckets: { ...qtaDoc.buckets, [category]: debited.bucket },
            });
            tx.put('capacity/global', { active: globalCap.active + 1 });
            tx.put(uCapPath, { active: uCap.active + 1 });
            tx.put(reqPath, reqRecord);

            return { status: 'execution-admitted', record: reqRecord, queueRecord: selectedQueue };
        }

        return { status: 'all-users-capped', record: null };
    });
}
