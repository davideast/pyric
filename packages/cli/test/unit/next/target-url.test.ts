import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { resolveSandboxTargetUrl } from '../../../src/next/target-url.js';

describe('resolveSandboxTargetUrl', () => {
  const saved = { sandbox: process.env.PYRIC_SANDBOX, port: process.env.PYRIC_SANDBOX_PORT };

  beforeEach(() => {
    delete process.env.PYRIC_SANDBOX;
    delete process.env.PYRIC_SANDBOX_PORT;
  });

  afterEach(() => {
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
