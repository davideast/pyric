/** `shouldAutoOpen` — the gate that decides whether `pyric serve` pops a
 *  browser. The actual spawn is best-effort and untested here (it shells out);
 *  the DECISION is the logic worth pinning, so a future change can't silently
 *  start opening browsers in CI or under the --json agent contract. */
import { describe, expect, it } from 'bun:test';
import { shouldAutoOpen } from '../../src/serve/open-browser.js';

const base = { json: false, noOpen: false, isTTY: true, env: {} as Record<string, string | undefined> };

describe('shouldAutoOpen', () => {
  it('opens in an interactive shell with no suppressors', () => {
    expect(shouldAutoOpen({ ...base })).toBe(true);
  });

  it('never opens under --json (stdout is the agent contract)', () => {
    expect(shouldAutoOpen({ ...base, json: true })).toBe(false);
  });

  it('never opens with --no-open', () => {
    expect(shouldAutoOpen({ ...base, noOpen: true })).toBe(false);
  });

  it('never opens when stdout is not a TTY (piped/redirected)', () => {
    expect(shouldAutoOpen({ ...base, isTTY: false })).toBe(false);
  });

  it('never opens in CI (CI env set)', () => {
    expect(shouldAutoOpen({ ...base, env: { CI: 'true' } })).toBe(false);
    expect(shouldAutoOpen({ ...base, env: { CI: '1' } })).toBe(false);
  });

  it('any single suppressor wins over an otherwise-open context', () => {
    expect(shouldAutoOpen({ json: true, noOpen: false, isTTY: true, env: { CI: 'true' } })).toBe(false);
  });
});
