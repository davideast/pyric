/**
 * Refresh-point boundary and non-finite `exp`/`nowMs` fail-closed guards for
 * `packages/pyric/src/sandbox/internal/id-token.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  isPastIdTokenRefreshPoint,
  TOKEN_REFRESH_BUFFER_MS,
} from '../../src/sandbox/internal/id-token.js';

describe('id-token refresh point', () => {
  it('refreshes strictly after exp * 1000 - TOKEN_REFRESH_BUFFER_MS', () => {
    const expSec = 1_767_229_200;
    const refreshBoundaryMs = expSec * 1000 - TOKEN_REFRESH_BUFFER_MS;

    expect(TOKEN_REFRESH_BUFFER_MS).toBe(30_000);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, refreshBoundaryMs - 1)).toBe(false);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, refreshBoundaryMs)).toBe(false);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, refreshBoundaryMs + 1)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, expSec * 1000)).toBe(true);
  });

  it('fails closed (returns true) on missing, non-numeric, non-finite, or overflowing exp', () => {
    const nowMs = Date.UTC(2026, 0, 1);

    expect(isPastIdTokenRefreshPoint(undefined, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({}, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: undefined }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: null }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: '1767229200' }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: Number.NaN }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: Number.POSITIVE_INFINITY }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: Number.NEGATIVE_INFINITY }, nowMs)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: 1e308 }, nowMs)).toBe(true);
  });

  it('fails closed (returns true) when nowMs is not finite', () => {
    const expSec = 1_767_229_200;

    expect(isPastIdTokenRefreshPoint({ exp: expSec }, Number.NaN)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, Number.POSITIVE_INFINITY)).toBe(true);
    expect(isPastIdTokenRefreshPoint({ exp: expSec }, Number.NEGATIVE_INFINITY)).toBe(true);
  });
});
