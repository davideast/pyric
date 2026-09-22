import { createHash } from 'node:crypto';

export const REAL_INFERENCE_ENABLED = false;

export const LIMITS = Object.freeze({
    global:  3,
    perUser: 2,
    leaseMs: 10_000,
});

export const QUEUE_LIMITS = Object.freeze({
    global:  24,
    perUser: 8,
    ttlMs:   30_000,
});

// Generous allowance policy so quota exhaustion does not mask capacity/fairness effects
export const POLICIES = Object.freeze({
    version: 'fair-allocation-v1',
    chat:  Object.freeze({ capacity: 100, refillPerMinute: 100 }),
    agent: Object.freeze({ capacity: 50,  refillPerMinute: 50  }),
});

// Low-allowance policy used specifically for allowance-exhaustion-interaction
export const LOW_ALLOWANCE_POLICIES = Object.freeze({
    version: 'fair-allocation-low-v1',
    chat:  Object.freeze({ capacity: 2, refillPerMinute: 0 }),
    agent: Object.freeze({ capacity: 1, refillPerMinute: 0 }),
});

export const VARIANTS = Object.freeze(['immediate', 'fifo', 'round-robin']);

/**
 * Deterministic 32-bit PRNG (Mulberry32).
 */
export function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
        t += 0x6D2B79F5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

export function scheduleHash(offers) {
    return createHash('sha256').update(JSON.stringify(offers)).digest('hex');
}

/**
 * Build deterministic open-loop arrival schedule for the noisy-user profile:
 * Alice offers 5 req/step, Bob 1 req/step, Carol 1 req/step across `steps` steps.
 */
export function buildNoisyUserSchedule({ steps = 6, baseTimeMs = 1_000, stepMs = 200, durationMs = 200 } = {}) {
    const offers = [];
    let index = 0;
    for (let step = 0; step < steps; step++) {
        const plannedAtMs = baseTimeMs + step * stepMs;
        // Alice sends 5 requests per step
        for (let a = 0; a < 5; a++) {
            const requestId = `noisy-alice-${step}-${a}`;
            offers.push({
                index: index++,
                uid: 'alice',
                cohort: 'noisy',
                requestId,
                category: 'chat',
                model: 'fake',
                payloadHash: `ph-${requestId}`,
                plannedAtMs,
                durationMs,
            });
        }
        // Bob and Carol each send 1 request per step
        for (const uid of ['bob', 'carol']) {
            const requestId = `noisy-${uid}-${step}`;
            offers.push({
                index: index++,
                uid,
                cohort: 'quiet',
                requestId,
                category: 'chat',
                model: 'fake',
                payloadHash: `ph-${requestId}`,
                plannedAtMs,
                durationMs,
            });
        }
    }
    return { offers, hash: scheduleHash(offers) };
}

/**
 * Build deterministic balanced backlogged schedule where alice, bob, and carol
 * each continuously offer equal demand.
 */
export function buildBalancedBacklogSchedule({ perUserCount = 6, baseTimeMs = 1_000, durationMs = 200 } = {}) {
    const offers = [];
    let index = 0;
    for (let i = 0; i < perUserCount; i++) {
        for (const uid of ['alice', 'bob', 'carol']) {
            const requestId = `bal-${uid}-${i}`;
            offers.push({
                index: index++,
                uid,
                cohort: 'backlogged',
                requestId,
                category: 'chat',
                model: 'fake',
                payloadHash: `ph-${requestId}`,
                plannedAtMs: baseTimeMs + i * 50,
                durationMs,
            });
        }
    }
    return { offers, hash: scheduleHash(offers) };
}

/**
 * Build deterministic short-and-long duration mix schedule using seeded PRNG.
 */
export function buildDurationMixSchedule({ seed = 42, count = 12, baseTimeMs = 1_000 } = {}) {
    const rand = mulberry32(seed);
    const users = ['alice', 'bob', 'carol'];
    const offers = [];
    for (let i = 0; i < count; i++) {
        const uid = users[i % users.length];
        const durationMs = rand() < 0.5 ? 200 : 1_000;
        const requestId = `mix-${uid}-${i}`;
        offers.push({
            index: i,
            uid,
            cohort: durationMs === 1_000 ? 'long-job' : 'short-job',
            requestId,
            category: 'chat',
            model: 'fake',
            payloadHash: `ph-${requestId}`,
            plannedAtMs: baseTimeMs + i * 50,
            durationMs,
        });
    }
    return { offers, hash: scheduleHash(offers) };
}
