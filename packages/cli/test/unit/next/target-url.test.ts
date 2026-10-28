import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxTargetUrl } from '../../../src/next/target-url.js';

describe('resolveSandboxTargetUrl', () => {
  const saved = { sandbox: process.env.PYRIC_SANDBOX, port: process.env.PYRIC_SANDBOX_PORT };
  const savedCwd = process.cwd();
  let isolated: string;

  beforeEach(() => {
    delete process.env.PYRIC_SANDBOX;
    delete process.env.PYRIC_SANDBOX_PORT;
    // Resolve from a directory with no .pyric/serve.json above it.
    isolated = mkdtempSync(join(tmpdir(), 'pyric-next-target-cwd-'));
    process.chdir(isolated);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(isolated, { recursive: true, force: true });
    if (saved.sandbox === undefined) delete process.env.PYRIC_SANDBOX;
    else process.env.PYRIC_SANDBOX = saved.sandbox;
    if (saved.port === undefined) delete process.env.PYRIC_SANDBOX_PORT;
    else process.env.PYRIC_SANDBOX_PORT = saved.port;
  });

  it('maps ws and wss schemes to http and https for the option url', () => {
    expect(resolveSandboxTargetUrl({ url: 'ws://localhost:4000/' })).toBe('http://localhost:4000');
    expect(resolveSandboxTargetUrl({ url: 'wss://host.example' })).toBe('https://host.example');
    expect(resolveSandboxTargetUrl({ url: 'http://localhost:4000' })).toBe('http://localhost:4000');
  });

  it('maps ws and wss schemes in a remote PYRIC_SANDBOX value', () => {
    process.env.PYRIC_SANDBOX = 'remote:ws://127.0.0.1:4100';
    expect(resolveSandboxTargetUrl()).toBe('http://127.0.0.1:4100');
    process.env.PYRIC_SANDBOX = 'remote:wss://sandbox.example/';
    expect(resolveSandboxTargetUrl()).toBe('https://sandbox.example');
  });

  describe('with a project locator', () => {
    let project: string;
    const originalWarn = console.warn;
    let warnings: string[];

    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), 'pyric-next-target-'));
      mkdirSync(join(project, '.pyric'), { recursive: true });
      writeFileSync(
        join(project, '.pyric', 'serve.json'),
        JSON.stringify({ url: 'http://localhost:5174', port: 5174, instanceId: 'host' }),
      );
      warnings = [];
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    });

    afterEach(() => {
      console.warn = originalWarn;
      rmSync(project, { recursive: true, force: true });
    });

    it('skips a locator left by a process that has exited', () => {
      const exited = spawnSync(process.execPath, ['-e', '0']);
      writeFileSync(
        join(project, '.pyric', 'serve.json'),
        JSON.stringify({ url: 'http://localhost:5174', port: 5174, pid: exited.pid }),
      );
      process.env.PYRIC_SANDBOX = 'remote:http://localhost:5173';
      expect(resolveSandboxTargetUrl(undefined, project)).toBe('http://localhost:5173');
      expect(warnings).toEqual([]);
    });

    it('resolves bare remote to the url the project locator records', () => {
      process.env.PYRIC_SANDBOX = 'remote';
      expect(resolveSandboxTargetUrl(undefined, project)).toBe('http://localhost:5174');
      expect(warnings).toEqual([]);
    });

    it('keeps an explicit url on the port the locator records', () => {
      process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:5174';
      expect(resolveSandboxTargetUrl(undefined, project)).toBe('http://127.0.0.1:5174');
      expect(warnings).toEqual([]);
    });

    it('replaces an explicit url on another port with the locator url, and says so', () => {
      process.env.PYRIC_SANDBOX = 'remote:http://localhost:5173';
      expect(resolveSandboxTargetUrl(undefined, project)).toBe('http://localhost:5174');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('PYRIC_SANDBOX=remote:http://localhost:5173');
      expect(warnings[0]).toContain('http://localhost:5174');
      expect(warnings[0]).toContain('PYRIC_SANDBOX=remote');
    });
  });

  it('resolves bare remote without a locator through the port fallbacks', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pyric-next-target-empty-'));
    try {
      process.env.PYRIC_SANDBOX = 'remote';
      process.env.PYRIC_SANDBOX_PORT = '4123';
      expect(resolveSandboxTargetUrl(undefined, empty)).toBe('http://127.0.0.1:4123');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('falls back to the default port for an environment port outside 1 to 65535', () => {
    for (const value of ['', '0', '-1', '65536', '1.5', 'abc', ' ']) {
      process.env.PYRIC_SANDBOX_PORT = value;
      expect(resolveSandboxTargetUrl()).toBe('http://127.0.0.1:4000');
    }
    process.env.PYRIC_SANDBOX_PORT = '65535';
    expect(resolveSandboxTargetUrl()).toBe('http://127.0.0.1:65535');
    process.env.PYRIC_SANDBOX_PORT = '1';
    expect(resolveSandboxTargetUrl()).toBe('http://127.0.0.1:1');
  });

  it('rejects an option port outside 1 to 65535', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => resolveSandboxTargetUrl({ port })).toThrow(/port/);
    }
    expect(resolveSandboxTargetUrl({ port: 65535 })).toBe('http://127.0.0.1:65535');
  });
});
