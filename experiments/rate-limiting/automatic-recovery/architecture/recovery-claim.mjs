import { requestPath } from '../../integrated-admission/architecture/admission.mjs';

const failure = code => Object.assign(new Error(code), { code });
const TERMINAL = ['completed', 'cancelled', 'refunded'];

/**
 * Atomically claim an expired non-terminal reservation.
 * Never trusts stale query snapshots: re-reads current state inside the transaction.
 *
 * @param {object} store
 * @param {{ uid: string, requestId: string }} request
 * @param {{ owner: string, now: () => number, leaseMs: number }} options
 * @param {object} context
 */
export async function claimExpired(store, request, { owner, now, leaseMs }, context) {
    const reqPath = requestPath(request.uid, request.requestId);
    return store.transaction(context, async tx => {
        const record = await tx.get(reqPath);
        if (!record) return { status: 'missing', record: null };
        if (TERMINAL.includes(record.state)) return { status: 'already-terminal', record };
        if (record.leaseUntil > now()) return { status: 'lease-owned', record };

        const claimed = {
            ...record,
            owner,
            fence:     record.fence + 1,
            leaseUntil: now() + leaseMs,
        };
        tx.put(reqPath, claimed);
        return { status: 'claimed', record: claimed };
    });
}

/**
 * Extend the lease of a live reservation owned by `owner` at `fence`.
 */
export async function renewHeartbeat(store, request, fence, { owner, now, leaseMs }, context) {
    const reqPath = requestPath(request.uid, request.requestId);
    return store.transaction(context, async tx => {
        const record = await tx.get(reqPath);
        if (!record) throw failure('missing-reservation');
        if (record.owner !== owner || record.fence !== fence) throw failure('stale-owner');
        if (record.leaseUntil <= now()) throw failure('lease-expired');

        const renewed = { ...record, leaseUntil: now() + leaseMs };
        tx.put(reqPath, renewed);
        return renewed;
    });
}

/**
 * Deterministic bounded due-candidate query with cursor pagination.
 * Orders by (nextCheckAt ASC, requestId ASC) and advances past `cursor`
 * so stuck/unknown page-1 items never starve later pages.
 *
 * @param {Array<{ id: string, data: object }>} records
 * @param {{ now: number, pageSize: number, cursor?: { nextCheckAt: number, requestId: string } | null }} options
 */
export function selectDueCandidates(records, { now, pageSize, cursor = null }) {
    const eligible = records
        .map(row => row.data)
        .filter(data =>
            data
            && !TERMINAL.includes(data.state)
            && !data.quarantineReason
            && data.leaseUntil <= now
            && (data.nextCheckAt ?? 0) <= now,
        )
        .sort((a, b) => {
            const diff = (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0);
            if (diff !== 0) return diff;
            return String(a.requestId).localeCompare(String(b.requestId));
        });

    const afterCursor = cursor
        ? eligible.filter(item => {
            const checkA = item.nextCheckAt ?? 0;
            if (checkA > cursor.nextCheckAt) return true;
            if (checkA < cursor.nextCheckAt) return false;
            return String(item.requestId).localeCompare(String(cursor.requestId)) > 0;
        })
        : eligible;

    const page = afterCursor.slice(0, pageSize);
    const last = page[page.length - 1];
    const nextCursor = last
        ? { nextCheckAt: last.nextCheckAt ?? 0, requestId: last.requestId }
        : null;

    return {
        page,
        nextCursor: afterCursor.length > page.length ? nextCursor : null,
        totalEligible: eligible.length,
    };
}
