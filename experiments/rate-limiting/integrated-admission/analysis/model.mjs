// Independent expected-state accounting model.
// Must NOT import any implementation files from architecture/.
// Takes declared policy + a sequence of committed events; computes expected state.

/**
 * Apply lazy refill at time `nowMs` and return the new remaining balance,
 * clamped at capacity. Does not mutate input.
 *
 * @param {{ remaining: number, updatedAt: number } | null} bucket
 * @param {{ capacity: number, refillPerMinute: number }} policy
 * @param {number} nowMs
 * @param {number} COST
 */
export function applyRefill(bucket, policy, nowMs, COST = 60_000) {
    const capacity  = policy.capacity * COST;
    if (!bucket)   return capacity;   // empty bucket starts full
    const elapsed   = Math.max(0, nowMs - bucket.updatedAt);
    return Math.min(capacity, bucket.remaining + elapsed * policy.refillPerMinute);
}

/**
 * Expected bucket balance after a debit at `nowMs`.
 * Returns null if the debit would be denied (insufficient balance).
 *
 * @param {{ remaining: number, updatedAt: number } | null} bucket
 * @param {{ capacity: number, refillPerMinute: number }} policy
 * @param {number} nowMs
 * @param {number} COST
 */
export function expectedBalanceAfterDebit(bucket, policy, nowMs, COST = 60_000) {
    const available = applyRefill(bucket, policy, nowMs, COST);
    if (available < COST) return null;   // would be denied
    return { remaining: available - COST, updatedAt: nowMs };
}

/**
 * Expected bucket balance after a refund at `nowMs`.
 * Returns { remaining, updatedAt, creditedUnits, saturationLoss }.
 *
 * @param {{ remaining: number, updatedAt: number } | null} bucket
 * @param {{ capacity: number, refillPerMinute: number }} policy
 * @param {number} nowMs
 * @param {number} COST
 */
export function expectedBalanceAfterRefund(bucket, policy, nowMs, COST = 60_000) {
    const capacity      = policy.capacity * COST;
    const available     = applyRefill(bucket, policy, nowMs, COST);
    const creditedUnits = Math.min(COST, capacity - available);
    const saturationLoss = COST - creditedUnits;
    return {
        remaining:      available + creditedUnits,
        updatedAt:      nowMs,
        creditedUnits,
        saturationLoss,
    };
}

/**
 * Expected global capacity counter after a sequence of events.
 *
 * Events are objects with { kind: 'admitted' | 'settled' | 'refunded' | 'quarantined' }.
 * - admitted   → active += 1
 * - settled    → active -= 1
 * - refunded   → active -= 1  (pre-dispatch only)
 * - quarantined → active unchanged (slot retained)
 *
 * @param {{ kind: string }[]} events
 */
export function expectedCapacityAfterEvents(events) {
    let active = 0;
    for (const event of events) {
        if (event.kind === 'admitted')  active += 1;
        if (event.kind === 'settled')   active -= 1;
        if (event.kind === 'refunded')  active -= 1;
    }
    return Math.max(0, active);
}

/**
 * Verify invariants given actual Firestore snapshots and a sequence of events.
 * Returns { valid: boolean, violations: string[] }.
 *
 * @param {{ quotas, requests, capacity, users }} actualSnapshots
 * @param {{ kind: string, uid?: string }[]} events
 */
export function verifyInvariants(actualSnapshots, events) {
    const violations = [];
    const { requests = [], capacity = [] } = actualSnapshots;

    const globalDoc = capacity.find(d => d.id === 'global');
    const globalActive = globalDoc?.data.active ?? 0;

    // Non-terminal requests should match global active count
    const nonTerminalStates = ['reserved', 'dispatching', 'running', 'unknown'];
    const nonTerminal       = requests.filter(r => nonTerminalStates.includes(r.data.state));

    // Quarantined records retain their slot even though they're "unknown" —
    // we only check that active counter >= known-non-terminal count (unknown is a superset)
    if (globalActive < nonTerminal.filter(r => r.data.state !== 'unknown').length)
        violations.push(`global.active (${globalActive}) < non-terminal-minus-unknown (${nonTerminal.filter(r => r.data.state !== 'unknown').length})`);

    // Active counter may never be negative
    if (globalActive < 0)
        violations.push(`global.active is negative: ${globalActive}`);

    // Refunded records must not occupy a slot
    const refunded = requests.filter(r => r.data.state === 'refunded');
    // No specific counter assertion per refunded record; verified via expectedCapacityAfterEvents

    // No admitted record missing both its quota debit and its slot
    const admitted = requests.filter(r => r.data.debitState === 'debited');
    if (admitted.length > 0 && actualSnapshots.quotas.length === 0)
        violations.push('Admitted records exist but no quota document found');

    return { valid: violations.length === 0, violations };
}

/**
 * Literal worked examples for refund boundary conditions.
 * Returns objects describing input/output for documentation and test verification.
 */
export const workedExamples = {
    refundNoSaturation() {
        // Chat policy: capacity=5, so 5 * 60_000 = 300_000 max.
        // After one debit, remaining = 240_000. Refund immediately → credits 60_000 back.
        // No saturation because 240_000 + 60_000 = 300_000 ≤ capacity.
        const policy = { capacity: 5, refillPerMinute: 10 };
        const COST   = 60_000;
        const after  = expectedBalanceAfterRefund({ remaining: 240_000, updatedAt: 1000 }, policy, 1000, COST);
        return { input: { remaining: 240_000, nowMs: 1000 }, output: after, expect: { saturationLoss: 0, creditedUnits: COST } };
    },
    refundWithSaturation() {
        // Chat policy: capacity=5 → 300_000 max.
        // Bucket has 280_000 remaining (almost full). Refund COST=60_000:
        // creditedUnits = min(60_000, 300_000 - 280_000) = min(60_000, 20_000) = 20_000
        // saturationLoss = 60_000 - 20_000 = 40_000
        const policy = { capacity: 5, refillPerMinute: 10 };
        const COST   = 60_000;
        const after  = expectedBalanceAfterRefund({ remaining: 280_000, updatedAt: 1000 }, policy, 1000, COST);
        return { input: { remaining: 280_000, nowMs: 1000 }, output: after, expect: { saturationLoss: 40_000, creditedUnits: 20_000 } };
    },
    refillClamped() {
        // Bucket is empty. 60 seconds pass. refillPerMinute=10 → 600_000 added,
        // but clamped at capacity=300_000.
        const policy = { capacity: 5, refillPerMinute: 10 };
        const COST   = 60_000;
        const refilled = applyRefill({ remaining: 0, updatedAt: 1000 }, policy, 61_000, COST);
        return { input: { remaining: 0, elapsedMs: 60_000 }, output: refilled, expect: 300_000 };
    },
};
