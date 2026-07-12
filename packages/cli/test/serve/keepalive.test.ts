/** keepalive size gate for the unload flush (pyric-persist 4.3). */
import { afterEach, describe, expect, it } from 'bun:test';
import { keepaliveSafe, __resetKeepaliveWarning, KEEPALIVE_MAX_BYTES } from '../../src/serve/entries/keepalive.js';

afterEach(() => __resetKeepaliveWarning());

describe('keepaliveSafe', () => {
  it('enables keepalive for small bodies', () => {
    expect(keepaliveSafe('{}', () => {})).toBe(true);
    expect(keepaliveSafe('x'.repeat(KEEPALIVE_MAX_BYTES), () => {})).toBe(true);
  });

  it('skips keepalive above the cap and warns exactly once', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const big = 'x'.repeat(KEEPALIVE_MAX_BYTES + 1);
    expect(keepaliveSafe(big, warn)).toBe(false);
    expect(keepaliveSafe(big, warn)).toBe(false); // still skipped
    expect(warnings).toHaveLength(1); // warned once
    expect(warnings[0]).toContain('KB');
    expect(warnings[0].toLowerCase()).toContain('close the tab');
  });

  it('counts UTF-8 bytes, not characters', () => {
    // multi-byte chars push a sub-cap char count over the byte cap
    const halfChars = '✓'.repeat(Math.ceil(KEEPALIVE_MAX_BYTES / 3) + 1); // 3 bytes each
    expect(keepaliveSafe(halfChars, () => {})).toBe(false);
  });
});
