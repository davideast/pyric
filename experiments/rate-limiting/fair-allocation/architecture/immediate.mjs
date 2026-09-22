import { admit } from '../../integrated-admission/architecture/admission.mjs';

const failure = code => Object.assign(new Error(code), { code });

/**
 * Immediate admission baseline: attempts direct transactional admission
 * without queueing. Maps integrated-admission status values to outcome buckets.
 */
export async function admitImmediate(store, request, { policies, limits, owner, now }, context) {
    const res = await admit(store, request, { policies, limits, owner, now }, context);
    if (res.status === 'admitted') {
        return { status: 'execution-admitted', record: res.record };
    }
    if (res.status === 'duplicate') {
        return { status: 'duplicate', record: res.record };
    }
    if (res.status === 'conflict') {
        throw failure('payload_mismatch');
    }
    if (res.status === 'quota_exhausted') {
        return { status: 'quota-denied', reason: 'quota_exhausted', record: null };
    }
    return { status: 'capacity-rejected', reason: 'busy', record: null };
}
