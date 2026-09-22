import { describe, expect, test } from 'bun:test';
import { captureDefinition, implementationHash } from '../capture-definition.mjs';
import { scenarios } from '../scenarios/registry.mjs';

describe('capture-definition & scenario registry', () => {
    test('captureDefinition produces non-empty sourcePaths and 64-char sha256 implementationHash', () => {
        const def = captureDefinition();
        expect(def.experiment).toBe('experiments/rate-limiting/fair-allocation');
        expect(def.sourcePaths.length).toBeGreaterThanOrEqual(15);

        const hash = implementationHash();
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('registry contains all 11 scenarios including 10 core cases and 1 negative control', () => {
        const ids = Object.keys(scenarios);
        expect(ids).toHaveLength(11);
        expect(ids).toEqual([
            'balanced-backlogged-users',
            'one-noisy-two-quiet-users',
            'short-and-long-operations',
            'distinct-user-burst',
            'duplicate-offer-storm',
            'queue-overload',
            'queue-cancellation-and-expiry',
            'unknown-running-work',
            'selector-restart-and-competing-selectors',
            'allowance-exhaustion-interaction',
            'unbounded-no-cap-control',
        ]);
    });
});
