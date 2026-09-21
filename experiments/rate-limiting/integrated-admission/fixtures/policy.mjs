// Pilot accounting contract for variant integrated-v1.
// A different refund policy is a separate variant, not an edit to this file.
// Store policyVersion in every capture to bind evidence to this policy.

export const POLICY_VERSION = 'integrated-v1';

/** Token-bucket policy per category.
 * capacity: maximum credits (each request costs COST = 60_000 units)
 * refillPerMinute: integer units added per millisecond (1 unit/ms = 1 req/min)
 */
export const POLICIES = {
    version: POLICY_VERSION,
    chat:  { capacity: 5, refillPerMinute: 10 },
    agent: { capacity: 2, refillPerMinute: 1  },
};

/** Execution-capacity limits shared across all cases in this variant. */
export const LIMITS = {
    global:  3,        // max concurrent provider calls across all users
    perUser: 2,        // max concurrent provider calls per uid
    leaseMs: 10_000,   // lease duration before a reservation can be taken over
};
