/**
 * Permission-dial state machine + policy-mapping tests (F3).
 *
 * Locks the three load-bearing contracts:
 *   1. which quadrants are selectable (sandbox yes, prod locked off),
 *   2. mode → confirm-policy descriptor mapping,
 *   3. defence-in-depth: prod modes never produce a policy.
 */

import { describe, it, expect } from 'bun:test';

import {
  QUADRANTS,
  DEFAULT_MODE_ID,
  modeId,
  modeFromId,
  quadrant,
  isSelectable,
  toPolicyRequest,
  type DialModeId,
} from './policy.js';

describe('quadrant inventory', () => {
  it('has exactly the four 2×2 modes', () => {
    const ids = QUADRANTS.map((q) => q.id).sort();
    const expected: DialModeId[] = [
      'sandbox:review',
      'sandbox:no-review',
      'prod:review',
      'prod:no-review',
    ];
    expect(ids).toEqual(expected.sort());
  });

  it('only the two sandbox quadrants are selectable', () => {
    const selectable = QUADRANTS.filter((q) => q.selectable).map((q) => q.id);
    const expected: DialModeId[] = ['sandbox:review', 'sandbox:no-review'];
    expect(selectable.sort()).toEqual(expected.sort());
  });

  it('both prod quadrants are locked with a "prod gated off" reason', () => {
    for (const id of ['prod:review', 'prod:no-review'] as DialModeId[]) {
      const q = quadrant(id);
      expect(q.selectable).toBe(false);
      expect(q.lockedReason).toMatch(/prod gated off/i);
    }
  });

  it('reserves danger/caution tones for the prod column', () => {
    expect(quadrant('prod:no-review').tone).toBe('danger');
    expect(quadrant('prod:review').tone).toBe('caution');
    expect(quadrant('sandbox:review').tone).toBe('safe');
    expect(quadrant('sandbox:no-review').tone).toBe('safe');
  });

  it('default mode is Sandbox · Review and is selectable', () => {
    expect(DEFAULT_MODE_ID).toBe('sandbox:review');
    expect(isSelectable(DEFAULT_MODE_ID)).toBe(true);
  });
});

describe('id <-> mode round-trip', () => {
  it('modeId/modeFromId are inverses for every quadrant', () => {
    for (const q of QUADRANTS) {
      expect(modeId(q.mode)).toBe(q.id);
      expect(modeFromId(q.id)).toEqual(q.mode);
    }
  });
});

describe('isSelectable', () => {
  it('is true for sandbox, false for prod', () => {
    expect(isSelectable('sandbox:review')).toBe(true);
    expect(isSelectable('sandbox:no-review')).toBe(true);
    expect(isSelectable('prod:review')).toBe(false);
    expect(isSelectable('prod:no-review')).toBe(false);
  });
});

describe('toPolicyRequest: mode → confirm-policy mapping', () => {
  it('sandbox:no-review → everything auto-approved (fallback never)', () => {
    const req = toPolicyRequest(modeFromId('sandbox:no-review'));
    expect(req.bridgeMode).toBe('sandbox');
    expect(req.base).toBe('sandbox');
    expect(req.fallback).toBe('never');
    expect(req.overrides).toEqual({});
  });

  it('sandbox:review → prod-defaults base (writes prompt), fallback always', () => {
    const req = toPolicyRequest(modeFromId('sandbox:review'));
    expect(req.bridgeMode).toBe('sandbox');
    expect(req.base).toBe('prod-defaults');
    expect(req.fallback).toBe('always');
  });

  it('review vs no-review produce different fallbacks (the dial actually changes behaviour)', () => {
    const review = toPolicyRequest(modeFromId('sandbox:review'));
    const noReview = toPolicyRequest(modeFromId('sandbox:no-review'));
    expect(review.fallback).not.toBe(noReview.fallback);
    expect(review.base).not.toBe(noReview.base);
  });

  it('throws for prod modes: gated off must never reach the policy layer', () => {
    expect(() => toPolicyRequest(modeFromId('prod:review'))).toThrow(
      /gated off/i,
    );
    expect(() => toPolicyRequest(modeFromId('prod:no-review'))).toThrow(
      /gated off/i,
    );
  });
});
