/**
 * Hybrid MCP selector (Phase 2 of design rationale).
 *
 * When no `pyric dev --bridge` is discovered, `runMcpProxy` now hosts a
 * headless in-process sandbox instead of erroring (exit 2). The attach (relay)
 * path is unchanged and blocks on real stdin (so it is deliberately not exercised
 * here — doing so risks a hung test); we test the new fallback branch via the
 * injected `discover` + `headless` seams.
 */
import { describe, it, expect } from 'bun:test';
import { runMcpProxy } from '../../src/cli/mcp-proxy.js';
import { parseArgs } from '../../src/cli/parse-args.js';

/** Parse a `pyric mcp ...` command line the way the CLI entry point does. */
function mcpArgs(...argv: string[]) {
  return parseArgs(['mcp', ...argv]);
}

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

describe('mcp --headless', () => {
  it('goes straight to the in-process sandbox without consulting discovery', async () => {
    let consultedDiscover = false;
    let headlessCwd: string | null = null;
    const code = await runMcpProxy(mcpArgs('--headless'), '/proj', {
      discover: async () => {
        consultedDiscover = true;
        return null;
      },
      headless: async (cwd) => {
        headlessCwd = cwd;
        return 0;
      },
      env: {},
    });
    expect(consultedDiscover).toBe(false);
    expect(headlessCwd).toBe('/proj');
    expect(code).toBe(0);
  });

  it('leaves the attach path alone when the flag is absent', async () => {
    let consultedDiscover = false;
    await runMcpProxy(mcpArgs(), '/proj', {
      discover: async () => {
        consultedDiscover = true;
        return null;
      },
      headless: async () => 0,
      env: {},
    });
    expect(consultedDiscover).toBe(true);
  });
});

describe('mcp tool-surface selection', () => {
  async function selectedSurface(
    argv: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<string | undefined> {
    let surface: string | undefined;
    await runMcpProxy(mcpArgs(...argv), '/proj', {
      discover: async () => null,
      headless: async (_cwd, options) => {
        surface = options.surface;
        return 0;
      },
      env,
    });
    return surface;
  }

  it('takes the surface from --surface', async () => {
    expect(await selectedSurface(['--headless', '--surface', 'noun-prefixed'], {})).toBe(
      'noun-prefixed',
    );
  });

  it('falls back to PYRIC_TOOL_SURFACE', async () => {
    expect(
      await selectedSurface(['--headless'], { PYRIC_TOOL_SURFACE: 'verb-suffixed' }),
    ).toBe('verb-suffixed');
  });

  it('prefers the flag over the environment', async () => {
    expect(
      await selectedSurface(['--headless', '--surface=discriminator'], {
        PYRIC_TOOL_SURFACE: 'verb-suffixed',
      }),
    ).toBe('discriminator');
  });

  it('selects no surface when neither is set, on the attach fallback too', async () => {
    expect(await selectedSurface(['--headless'], {})).toBe(undefined);
    expect(await selectedSurface([], {})).toBe(undefined);
  });
});
