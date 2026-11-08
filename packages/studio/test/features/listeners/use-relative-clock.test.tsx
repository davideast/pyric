import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import { useRelativeClock } from '../../../src/features/listeners/use-relative-clock.js';

afterEach(() => cleanup());

describe('useRelativeClock', () => {
  it('returns an explicit now timestamp verbatim and falls back to wall-clock time otherwise', () => {
    const fixed = renderHook(() => useRelativeClock(42_000));
    expect(fixed.result.current).toBe(42_000);

    const before = Date.now();
    const live = renderHook(() => useRelativeClock());
    expect(live.result.current).toBeGreaterThanOrEqual(before);
  });
});
