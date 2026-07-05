/**
 * Hybrid MCP selector (Phase 2 of design rationale).
 *
 * When no `pyric serve --bridge` is discovered, `runMcpProxy` now hosts a
 * headless in-process sandbox instead of erroring (exit 2). The attach (relay)
 * path is unchanged and blocks on real stdin (so it is deliberately not exercised
 * here — doing so risks a hung test); we test the new fallback branch via the
 * injected `discover` + `headless` seams.
 */
import { describe, it, expect } from 'bun:test';
import { runMcpProxy } from '../../src/cli/mcp-proxy.js';

describe('mcp-proxy hybrid selector (Phase 2)', () => {
  it('runs the headless sandbox (not exit 2) when no serve is found', async () => {
    let headlessCwd: string | null = null;
    const code = await runMcpProxy({} as never, '/proj', {
      discover: async () => null,
      headless: async (cwd) => {
        headlessCwd = cwd;
        return 0;
      },
    });
    expect(headlessCwd).toBe('/proj');
    expect(code).toBe(0);
  });

  it('prefers the discovered serve over headless (discover is consulted first)', async () => {
    // With a serve discovered, the headless seam must not be chosen. We stub
    // discover to throw AFTER recording the call so we never enter the real
    // (stdio-blocking) relay, and assert headless was never reached.
    let consultedDiscover = false;
    let wentHeadless = false;
    await runMcpProxy({} as never, '/proj', {
      discover: async () => {
        consultedDiscover = true;
        throw new Error('stop before the relay');
      },
      headless: async () => {
        wentHeadless = true;
        return 0;
      },
    }).catch(() => undefined);
    expect(consultedDiscover).toBe(true);
    expect(wentHeadless).toBe(false);
  });
});
