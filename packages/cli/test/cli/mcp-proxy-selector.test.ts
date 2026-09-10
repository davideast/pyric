/**
 * Hybrid MCP selector (Phase 2 of design rationale).
 *
 * When no `pyric dev --bridge` is discovered, `runMcpProxy` now hosts an
 * in-process sandbox instead of erroring (exit 2). The attach (relay)
 * path is unchanged and blocks on real stdin (so it is deliberately not exercised
 * here, since doing so risks a hung test); we test the new fallback branch via the
 * injected `discover` + `inProcess` seams.
 */
import { describe, it, expect } from 'bun:test';
import { runMcpProxy, selectAllowProduction } from '../../src/cli/mcp-proxy.js';
import { parseArgs } from '../../src/cli/parse-args.js';

/** Parse a `pyric mcp ...` command line the way the CLI entry point does. */
function mcpArgs(...argv: string[]) {
  return parseArgs(['mcp', ...argv]);
}

describe('mcp --attach', () => {
  it('fails rather than owning a sandbox when no serve is running', async () => {
    let wentInProcess = false;
    const code = await runMcpProxy(mcpArgs('--attach'), '/proj', {
      discover: async () => null,
      inProcess: async () => {
        wentInProcess = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(wentInProcess).toBe(false);
  });

  it('refuses --attach together with --in-process', async () => {
    let consultedDiscover = false;
    let wentInProcess = false;
    const code = await runMcpProxy(mcpArgs('--attach', '--in-process'), '/proj', {
      discover: async () => {
        consultedDiscover = true;
        return null;
      },
      inProcess: async () => {
        wentInProcess = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(consultedDiscover).toBe(false);
    expect(wentInProcess).toBe(false);
  });
});

describe('mcp-proxy hybrid selector (Phase 2)', () => {
  it('runs the in-process sandbox (not exit 2) when no serve is found', async () => {
    let inProcessCwd: string | null = null;
    const code = await runMcpProxy({} as never, '/proj', {
      discover: async () => null,
      inProcess: async (cwd) => {
        inProcessCwd = cwd;
        return 0;
      },
    });
    expect(inProcessCwd).toBe('/proj');
    expect(code).toBe(0);
  });

  it('prefers the discovered serve over in-process (discover is consulted first)', async () => {
    // With a serve discovered, the in-process seam must not be chosen. We stub
    // discover to throw AFTER recording the call so we never enter the real
    // (stdio-blocking) relay, and assert in-process was never reached.
    let consultedDiscover = false;
    let wentInProcess = false;
    await runMcpProxy({} as never, '/proj', {
      discover: async () => {
        consultedDiscover = true;
        throw new Error('stop before the relay');
      },
      inProcess: async () => {
        wentInProcess = true;
        return 0;
      },
    }).catch(() => undefined);
    expect(consultedDiscover).toBe(true);
    expect(wentInProcess).toBe(false);
  });
});

describe('mcp --in-process', () => {
  it('goes straight to the in-process sandbox without consulting discovery', async () => {
    let consultedDiscover = false;
    let inProcessCwd: string | null = null;
    const code = await runMcpProxy(mcpArgs('--in-process'), '/proj', {
      discover: async () => {
        consultedDiscover = true;
        return null;
      },
      inProcess: async (cwd) => {
        inProcessCwd = cwd;
        return 0;
      },
      env: {},
    });
    expect(consultedDiscover).toBe(false);
    expect(inProcessCwd).toBe('/proj');
    expect(code).toBe(0);
  });

  it('leaves the attach path alone when the flag is absent', async () => {
    let consultedDiscover = false;
    await runMcpProxy(mcpArgs(), '/proj', {
      discover: async () => {
        consultedDiscover = true;
        return null;
      },
      inProcess: async () => 0,
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
      inProcess: async (_cwd, options) => {
        surface = options.surface;
        return 0;
      },
      env,
    });
    return surface;
  }

  it('takes the surface from --surface', async () => {
    expect(await selectedSurface(['--in-process', '--surface', 'noun-prefixed'], {})).toBe(
      'noun-prefixed',
    );
  });

  it('falls back to PYRIC_TOOL_SURFACE', async () => {
    expect(
      await selectedSurface(['--in-process'], { PYRIC_TOOL_SURFACE: 'verb-suffixed' }),
    ).toBe('verb-suffixed');
  });

  it('prefers the flag over the environment', async () => {
    expect(
      await selectedSurface(['--in-process', '--surface=discriminator'], {
        PYRIC_TOOL_SURFACE: 'verb-suffixed',
      }),
    ).toBe('discriminator');
  });

  it('selects no surface when neither is set, on the attach fallback too', async () => {
    expect(await selectedSurface(['--in-process'], {})).toBe(undefined);
    expect(await selectedSurface([], {})).toBe(undefined);
  });
});

describe('mcp project-directory selection', () => {
  async function selectedProjectDir(
    argv: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<string | undefined> {
    let projectDir: string | undefined;
    await runMcpProxy(mcpArgs(...argv), '/proj', {
      discover: async () => null,
      inProcess: async (_cwd, options) => {
        projectDir = options.projectDir;
        return 0;
      },
      env,
    });
    return projectDir;
  }

  it('takes the project directory from --project-dir', async () => {
    expect(await selectedProjectDir(['--in-process', '--project-dir', '/state/run-1'], {})).toBe(
      '/state/run-1',
    );
  });

  it('falls back to PYRIC_PROJECT_DIR', async () => {
    expect(
      await selectedProjectDir(['--in-process'], { PYRIC_PROJECT_DIR: '/state/from-env' }),
    ).toBe('/state/from-env');
  });

  it('prefers the flag over the environment', async () => {
    expect(
      await selectedProjectDir(['--in-process', '--project-dir=/state/from-flag'], {
        PYRIC_PROJECT_DIR: '/state/from-env',
      }),
    ).toBe('/state/from-flag');
  });

  it('selects no project directory when neither is set, so the server uses its cwd', async () => {
    expect(await selectedProjectDir(['--in-process'], {})).toBe(undefined);
    expect(await selectedProjectDir([], {})).toBe(undefined);
  });
});

/**
 * Production access is opt-in by an exact word. A variable left over from
 * another purpose, or a value that reads as a refusal, must not mount methods
 * that touch Google infrastructure, so only the literal `1` and `true` count.
 */
describe('mcp production-method selection', () => {
  function allowsProduction(argv: string[], env: NodeJS.ProcessEnv): boolean {
    return selectAllowProduction(parseArgs(['mcp', ...argv]), env);
  }

  it('mounts production methods for the flag', () => {
    expect(allowsProduction(['--in-process', '--allow-production'], {})).toBe(true);
  });

  it('mounts production methods for the two words the variable accepts', () => {
    expect(allowsProduction([], { PYRIC_ALLOW_PRODUCTION: '1' })).toBe(true);
    expect(allowsProduction([], { PYRIC_ALLOW_PRODUCTION: 'true' })).toBe(true);
  });

  it('mounts nothing for any other value of the variable', () => {
    for (const value of ['', '0', 'false', 'yes', 'TRUE', 'on', '2', ' 1']) {
      expect(allowsProduction([], { PYRIC_ALLOW_PRODUCTION: value })).toBe(false);
    }
  });

  it('mounts nothing when neither the flag nor the variable is set', () => {
    expect(allowsProduction([], {})).toBe(false);
  });
});
