import { describe, it, expect } from 'bun:test';
import { captureDefinition, implementationHash, EXPERIMENT } from '../capture-definition.mjs';
import { scenarios } from '../scenarios/registry.mjs';

describe('captureDefinition()', () => {
    it('reports the correct experiment path', () => {
        const def = captureDefinition();
        expect(def.experiment).toBe(EXPERIMENT);
    });

    it('includes the required artifacts list', () => {
        const def = captureDefinition();
        for (const artifact of ['result.json', 'assessment.json', 'workload.json', 'findings.md']) {
            expect(def.artifacts).toContain(artifact);
        }
    });

    it('source paths include shared modules', () => {
        const def = captureDefinition();
        expect(def.sourcePaths.some(p => p.includes('bucket.mjs'))).toBe(true);
        expect(def.sourcePaths.some(p => p.includes('store.mjs'))).toBe(true);
        expect(def.sourcePaths.some(p => p.includes('capture.mjs'))).toBe(true);
    });

    it('source paths are sorted and deduplicated', () => {
        const def  = captureDefinition();
        const copy = [...def.sourcePaths].sort();
        expect(def.sourcePaths).toEqual(copy);
        expect(def.sourcePaths.length).toBe(new Set(def.sourcePaths).size);
    });
});

describe('implementationHash()', () => {
    it('returns a 64-character hex string', () => {
        const h = implementationHash();
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable across two calls', () => {
        expect(implementationHash()).toBe(implementationHash());
    });
});

describe('workload contract completeness', () => {
    const REQUIRED_CASES = [
        'normal-chat', 'normal-agent',
        'capacity-busy', 'quota-exhausted',
        'duplicate-same-payload', 'duplicate-conflict',
        'native-retry', 'crash-before-commit', 'ack-lost',
        'pre-dispatch-cancel', 'cancel-vs-dispatch-race',
        'refund-after-refill', 'refund-saturation',
        'crash-after-dispatch', 'provider-unknown',
        'settlement-ack-lost', 'stale-fence',
        'split-admission-control',
    ];

    it('all required cases are registered', () => {
        for (const id of REQUIRED_CASES) {
            expect(scenarios[id]).toBeDefined();
        }
    });

    it('each scenario declares at least one check', () => {
        for (const [id, scenario] of Object.entries(scenarios)) {
            expect(scenario.checks.length).toBeGreaterThan(0);
        }
    });

    it('split-admission-control is the only negative control', () => {
        const negatives = Object.entries(scenarios)
            .filter(([, s]) => (s.expectedFailures?.length ?? 0) > 0)
            .map(([id]) => id);
        expect(negatives).toEqual(['split-admission-control']);
    });
});
