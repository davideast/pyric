/**
 * Detection of a child runtime that cannot evaluate Node loader hooks, and the
 * upfront stop error `pyric sandbox` raises before spawning it (ADR 0023).
 */
import { describe, expect, it } from 'bun:test';
import { parseCommandString } from '../../src/cli/sandbox-runner.js';
import {
  checkSandboxChildLaunch,
  detectUnsupportedRuntime,
  formatUnsupportedRuntimeStop,
  UNSUPPORTED_RUNTIME_CODE,
} from '../../src/cli/unsupported-runtime.js';

describe('detectUnsupportedRuntime', () => {
  it('detects a bare bun/deno command', () => {
    expect(detectUnsupportedRuntime(['bun', 'run', 'dev'])).toBe('bun');
    expect(detectUnsupportedRuntime(['deno', 'task', 'dev'])).toBe('deno');
  });

  it('detects bunx and an absolute/relative path to the binary', () => {
    expect(detectUnsupportedRuntime(['bunx', 'vite'])).toBe('bun');
    expect(detectUnsupportedRuntime(['/usr/local/bin/bun', 'server.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['./node_modules/.bin/deno', 'run', 'x.ts'])).toBe('deno');
    expect(detectUnsupportedRuntime(['C:\\tools\\bun.exe', 'start'])).toBe('bun');
  });

  it('looks past leading KEY=VAL assignments and shell operators', () => {
    expect(detectUnsupportedRuntime(['PORT=8080', 'bun', 'start'])).toBe('bun');
    expect(detectUnsupportedRuntime(['npm', 'run', 'build', '&&', 'bun', 'start'])).toBe('bun');
    expect(detectUnsupportedRuntime(parseCommandString('FOO="bar baz" bun run dev.ts'))).toBe('bun');
  });

  it('detects bun/deno after attached shell operators and inside subshell parentheses', () => {
    expect(detectUnsupportedRuntime(parseCommandString('echo a && echo b; bun run dev.ts'))).toBe('bun');
    expect(detectUnsupportedRuntime(parseCommandString('true && (bun run dev.ts)'))).toBe('bun');
    expect(detectUnsupportedRuntime(parseCommandString('false||deno task dev'))).toBe('deno');
    expect(detectUnsupportedRuntime(['((bunx', 'vite))'])).toBe('bun');
  });

  it('unwraps env, npx, pnpm/yarn dlx, and sh/bash/zsh -c launchers', () => {
    expect(detectUnsupportedRuntime(['/usr/bin/env', 'bun', 'run', 'dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['env', '-i', '-u', 'NODE_OPTIONS', 'FOO=1', '--', 'deno', 'run', 'x.ts'])).toBe('deno');
    expect(detectUnsupportedRuntime(['env', '-S', 'FOO=1 bun run dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['npx', 'bun', 'run', 'dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['npx', '--yes', 'bunx', 'vite'])).toBe('bun');
    expect(detectUnsupportedRuntime(['pnpm', 'dlx', 'deno', 'run', 'x.ts'])).toBe('deno');
    expect(detectUnsupportedRuntime(['yarn', 'dlx', 'bun', 'run', 'dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['sh', '-c', 'bun run dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['sh', '-c', 'true\nbun run dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['sh', '-cx', 'bun run dev.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['npm', 'exec', '--', 'bun', 'app.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['pnpm', 'bun', 'app.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['yarn', 'deno', 'run', 'app.ts'])).toBe('deno');
    expect(detectUnsupportedRuntime(['/bin/bash', '-lc', 'echo ready && deno task dev'])).toBe('deno');
    expect(detectUnsupportedRuntime(['zsh', '-c', 'env FOO="a b" bun server.ts'])).toBe('bun');
  });

  it('stays null for supported runtimes, safe wrappers, and names that merely contain bun', () => {
    expect(detectUnsupportedRuntime(['node', 'server.js'])).toBeNull();
    expect(detectUnsupportedRuntime(['node', '-e', 'const x = 1; bun()'])).toBeNull();
    expect(detectUnsupportedRuntime(['/usr/bin/env', 'FOO=1', 'node', 'server.js'])).toBeNull();
    expect(detectUnsupportedRuntime(['npx', 'tsx', 'server.ts'])).toBeNull();
    expect(detectUnsupportedRuntime(['pnpm', 'dlx', 'tsx', 'server.ts'])).toBeNull();
    expect(detectUnsupportedRuntime(['pnpm', 'run', 'dev'])).toBeNull();
    expect(detectUnsupportedRuntime(['sh', '-c', 'node server.js'])).toBeNull();
    expect(detectUnsupportedRuntime(['npm', 'run', 'dev'])).toBeNull();
    expect(detectUnsupportedRuntime(['bundle', 'exec', 'rails'])).toBeNull();
    expect(detectUnsupportedRuntime(['./bunny.sh'])).toBeNull();
    expect(detectUnsupportedRuntime([])).toBeNull();
  });
});

describe('formatUnsupportedRuntimeStop', () => {
  it('names PYRIC_UNSUPPORTED_RUNTIME, the live Firebase risk, and node / npx tsx alternatives', () => {
    const line = formatUnsupportedRuntimeStop('bun', 'bun run dev');
    expect(line).toContain(UNSUPPORTED_RUNTIME_CODE);
    expect(line).toContain('bun');
    expect(line).toContain('bun run dev');
    expect(line).toContain('module.registerHooks');
    expect(line).toContain('live Firebase');
    expect(line).toContain('node');
    expect(line).toContain('npx tsx');
    expect(line.toLowerCase()).not.toContain('warning only');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('names the caller command prefix when passed', () => {
    const line = formatUnsupportedRuntimeStop('deno', 'deno task dev', 'pyric run');
    expect(line.startsWith('pyric run: stopped before starting `deno` (`deno task dev`) [PYRIC_UNSUPPORTED_RUNTIME].')).toBe(true);
  });
});

describe('checkSandboxChildLaunch', () => {
  it('emits PYRIC_GUARD deprecation once and stops unsupported runtimes', () => {
    const lines: string[] = [];
    const slot: Record<symbol, unknown> = {};
    const env = { PYRIC_GUARD: 'block' } as NodeJS.ProcessEnv;
    expect(
      checkSandboxChildLaunch({ argv: ['node', 'server.js'], label: 'node server.js' }, 'pyric sandbox', {
        env,
        write: (line) => lines.push(line),
        slot,
      }),
    ).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PYRIC_GUARD is deprecated');

    expect(
      checkSandboxChildLaunch({ argv: ['bun', 'run', 'dev.ts'], label: 'bun run dev.ts' }, 'pyric run', {
        env,
        write: (line) => lines.push(line),
        slot,
      }),
    ).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('pyric run: stopped before starting `bun` (`bun run dev.ts`) [PYRIC_UNSUPPORTED_RUNTIME].');
  });
});
