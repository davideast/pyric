/**
 * Detection of a child runtime that cannot evaluate Node loader hooks.
 *
 * Command-name detection is the honest 90%, and the warning is explicit that
 * neither the loader swap nor the net-guard socket backstop covers such a
 * child.
 */
import { describe, expect, it } from 'bun:test';
import {
  detectUnsupportedRuntime,
  formatUnsupportedRuntimeWarning,
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
  });

  it('stays null for supported runtimes and for names that merely contain bun', () => {
    expect(detectUnsupportedRuntime(['node', 'server.js'])).toBeNull();
    expect(detectUnsupportedRuntime(['npx', 'tsx', 'server.ts'])).toBeNull();
    expect(detectUnsupportedRuntime(['npm', 'run', 'dev'])).toBeNull();
    expect(detectUnsupportedRuntime(['bundle', 'exec', 'rails'])).toBeNull();
    expect(detectUnsupportedRuntime(['./bunny.sh'])).toBeNull();
    expect(detectUnsupportedRuntime([])).toBeNull();
  });
});

describe('formatUnsupportedRuntimeWarning', () => {
  it('says interception is unsupported, names the live risk, and disclaims the net guard', () => {
    const line = formatUnsupportedRuntimeWarning('bun');
    expect(line).toContain('⚠ runtime');
    expect(line).toContain('bun');
    expect(line).toContain('not supported');
    expect(line).toContain('NOT be rewritten');
    expect(line).toContain('LIVE Firebase');
    expect(line).toContain('net-guard');
    expect(line).toContain('Node');
    expect(line.toLowerCase()).toContain('warning only');
    expect(line.endsWith('\n')).toBe(true);
  });
});
