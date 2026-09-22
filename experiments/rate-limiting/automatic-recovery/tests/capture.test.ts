import { describe, expect, test } from 'bun:test';
import { captureDefinition, implementationHash } from '../capture-definition.mjs';
import { scenarios } from '../scenarios/registry.mjs';

describe('capture-definition & scenario registry', () => {
  test('captureDefinition produces non-empty sourcePaths and 64-char sha256 implementationHash', () => {
    const def = captureDefinition();
    expect(def.experiment).toBe('experiments/rate-limiting/automatic-recovery');
    expect(def.sourcePaths.length).toBeGreaterThanOrEqual(15);

    const hash = implementationHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('registry contains all 14 scenarios including 13 core cases and 1 negative control', () => {
    const ids = Object.keys(scenarios);
    expect(ids).toHaveLength(14);
    expect(ids).toEqual([
      'death-after-reservation',
      'death-after-intent-before-start',
      'death-while-provider-runs',
      'provider-completes-while-gateway-dead',
      'two-recovery-workers-claim-race',
      'recovery-worker-dies-after-claim',
      'stale-observation-after-takeover',
      'settlement-commits-response-lost',
      'stop-acknowledged-not-confirmed',
      'provider-status-transiently-unavailable',
      'provider-forever-unobservable',
      'reconciler-backlog-spans-pages',
      'clock-offsets-and-renew-races',
      'expiry-only-release-control',
    ]);
  });
});
