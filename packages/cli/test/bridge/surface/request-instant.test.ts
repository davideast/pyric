/**
 * The one answer to "what instant does this request evaluate at".
 *
 * The guard case is the point of the file: an unparsable `requestTime` reaching
 * this helper must produce the clock's instant, not `NaN`. `checkRequestTime`
 * refuses one at the argument boundary, and this pins that the helper does not
 * depend on that check having run.
 */
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { requestInstant } from '../../../src/bridge/surface/request-instant.js';

/** A context over a sandbox whose clock is pinned to `pinned`. */
function pinnedContext(pinned: number) {
  const sandbox = initializeSandbox();
  getClock(sandbox).set(pinned);
  return createSurfaceContext(sandbox);
}

describe('the instant a simulated request evaluates at', () => {
  it('reads the sandbox clock when the call names none', () => {
    const pinned = Date.UTC(2031, 0, 1);

    expect(requestInstant(pinnedContext(pinned), undefined)).toBe(pinned);
  });

  it('reads the instant the call names', () => {
    const named = Date.UTC(2020, 0, 1);

    expect(requestInstant(pinnedContext(Date.UTC(2031, 0, 1)), new Date(named).toISOString()))
      .toBe(named);
  });

  it('falls back to the clock rather than answering NaN', () => {
    const pinned = Date.UTC(2031, 0, 1);

    expect(requestInstant(pinnedContext(pinned), 'not a date')).toBe(pinned);
  });
});
