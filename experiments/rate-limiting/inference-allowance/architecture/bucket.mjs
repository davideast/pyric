// Integer credit units: one request costs 60,000 units; refillPerMinute units/ms.
export const COST = 60000;
export function consume(bucket, policy, now) {
    const capacity = policy.capacity * COST;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(capacity) || capacity < COST
        || !Number.isSafeInteger(policy.refillPerMinute) || policy.refillPerMinute < 0)
        throw new Error('invalid_policy');
    const previous = bucket === undefined ? { remaining: capacity, updatedAt: now } : bucket;
    if (!previous || typeof previous !== 'object')
        throw new Error('invalid_quota');
    if (!Number.isSafeInteger(previous.remaining) || previous.remaining < 0 || previous.remaining > capacity
        || !Number.isSafeInteger(previous.updatedAt) || previous.updatedAt < 0)
        throw new Error('invalid_quota');
    // A backwards clock never creates credit. A forward skew is a trusted-clock limitation.
    const effectiveTime = Math.max(now, previous.updatedAt);
    const available = Math.min(capacity, previous.remaining + (effectiveTime - previous.updatedAt) * policy.refillPerMinute);
    if (available < COST)
        return { allowed: false, retryAfterMs: policy.refillPerMinute === 0 ? null : Math.ceil((COST - available) / policy.refillPerMinute) + Math.max(0, previous.updatedAt - now) };
    return { allowed: true, bucket: { remaining: available - COST, updatedAt: effectiveTime } };
}
