import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UNSUPPORTED_NODE_VERSION_CODE,
  UNSUPPORTED_RUNTIME_CODE,
  createUnsupportedNodeVersionError,
  createUnsupportedRuntimeError,
  detectNonNodeRuntime,
  requireNodeRuntime,
  requireRegisterHooks,
} from '../../src/register/node-version-stop.js';

const cliRoot = resolve(import.meta.dir, '../..');
const registerFile = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerFile).href;
const activationUrl = pathToFileURL(join(cliRoot, 'dist/register/activation.js')).href;

describe('requireNodeRuntime (PYRIC_UNSUPPORTED_RUNTIME, #1624)', () => {
  it('passes when neither Bun nor Deno runtime markers are present', () => {
    expect(detectNonNodeRuntime({ node: '24.16.0' }, undefined)).toBeNull();
    const lines: string[] = [];
    expect(() => {
      requireNodeRuntime('@pyric/cli/register', { node: '24.16.0' }, undefined, (line) => lines.push(line));
    }).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('throws PYRIC_UNSUPPORTED_RUNTIME naming Bun when process.versions.bun is set, even if node version >= 22.15', () => {
    const lines: string[] = [];
    let caught: (Error & { code?: string }) | undefined;
    try {
      requireNodeRuntime(
        '@pyric/cli/register',
        { node: '24.3.0', bun: '1.3.14' },
        undefined,
        (line) => lines.push(line),
      );
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe(UNSUPPORTED_RUNTIME_CODE);
    expect(caught?.message).toContain('@pyric/cli/register: Bun 1.3.14 is not a supported Node runtime');
    expect(caught?.message).toContain('Node >= 22.15');
    expect(caught?.message).toContain('npx tsx');
    expect(caught?.message).not.toContain(UNSUPPORTED_NODE_VERSION_CODE);
    expect(lines).toEqual([`${caught?.message ?? ''}\n`]);
  });

  it('throws PYRIC_UNSUPPORTED_RUNTIME naming Deno from process.versions.deno or globalThis.Deno', () => {
    let fromVersions: (Error & { code?: string }) | undefined;
    try {
      requireNodeRuntime('@pyric/cli/register', { node: '22.15.0', deno: '2.1.4' }, undefined);
    } catch (err) {
      fromVersions = err as Error & { code?: string };
    }
    expect(fromVersions?.code).toBe(UNSUPPORTED_RUNTIME_CODE);
    expect(fromVersions?.message).toContain('Deno 2.1.4');

    let fromGlobal: (Error & { code?: string }) | undefined;
    try {
      requireNodeRuntime('@pyric/cli/register', { node: '22.15.0' }, { version: { deno: '2.2.0' } });
    } catch (err) {
      fromGlobal = err as Error & { code?: string };
    }
    expect(fromGlobal?.code).toBe(UNSUPPORTED_RUNTIME_CODE);
    expect(fromGlobal?.message).toContain('Deno 2.2.0');

    const unknownDeno = createUnsupportedRuntimeError('@pyric/cli/register', { name: 'Deno', version: 'unknown' });
    expect(unknownDeno.code).toBe(UNSUPPORTED_RUNTIME_CODE);
    expect(unknownDeno.message).toContain('@pyric/cli/register: Deno is not a supported Node runtime');
  });

  it('stops bun --preload @pyric/cli/register with PYRIC_UNSUPPORTED_RUNTIME when PYRIC_SANDBOX is set and stays inert without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-bun-preload-stop-'));
    try {
      const appEntry = join(dir, 'app.mjs');
      writeFileSync(
        appEntry,
        `import { isRegisterActive } from ${JSON.stringify(activationUrl)};\n` +
          `import { active } from ${JSON.stringify(registerUrl)};\n` +
          `console.log('INERT_STATE ' + JSON.stringify({ active, marked: isRegisterActive() }));\n`,
      );

      const activeRun = spawnSync(process.execPath, ['--preload', registerFile, appEntry], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: undefined,
          PYRIC_SANDBOX: 'local',
          PYRIC_DEBUG: '1',
        },
        timeout: 15_000,
      });
      expect(activeRun.status).not.toBe(0);
      expect(activeRun.stdout).not.toContain('INERT_STATE');
      expect(activeRun.stderr).not.toContain('@pyric/cli/register: active');
      expect(activeRun.stderr).not.toContain('beacon ACTIVE');
      expect(activeRun.stderr).not.toContain(UNSUPPORTED_NODE_VERSION_CODE);
      expect(activeRun.stderr).toContain('Bun ');
      expect(activeRun.stderr).toContain(UNSUPPORTED_RUNTIME_CODE);

      const inertRun = spawnSync(process.execPath, ['--preload', registerFile, appEntry], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: undefined,
          PYRIC_SANDBOX: undefined,
        },
        timeout: 15_000,
      });
      expect(inertRun.status).toBe(0);
      expect(inertRun.stdout).toContain('INERT_STATE {"active":false,"marked":false}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('requireRegisterHooks (PYRIC_UNSUPPORTED_NODE_VERSION)', () => {
  it('returns registerHooks unchanged when present', () => {
    const hookFn = () => undefined;
    expect(requireRegisterHooks(hookFn, '@pyric/cli/register', '22.15.0')).toBe(hookFn);
  });

  it('throws PYRIC_UNSUPPORTED_NODE_VERSION and writes diagnostic when registerHooks is absent', () => {
    const lines: string[] = [];
    let caught: (Error & { code?: string }) | undefined;
    try {
      requireRegisterHooks(undefined, '@pyric/cli/register', '22.14.0', (line) => lines.push(line));
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe(UNSUPPORTED_NODE_VERSION_CODE);
    expect(caught?.message).toContain('@pyric/cli/register');
    expect(caught?.message).toContain('22.14.0');
    expect(caught?.message).toContain('>= 22.15');
    expect(caught?.message).toContain("require('firebase-admin')");
    expect(caught?.message).toContain('PYRIC_UNSUPPORTED_NODE_VERSION');
    expect(lines).toEqual([`${caught?.message ?? ''}\n`]);
  });

  it('creates a coded error naming the surface and Node version', () => {
    const err = createUnsupportedNodeVersionError('pyric() Vite plugin', '20.18.0');
    expect(err.code).toBe('PYRIC_UNSUPPORTED_NODE_VERSION');
    expect(err.message).toContain('pyric() Vite plugin');
    expect(err.message).toContain('20.18.0');
  });

  it('stops @pyric/cli/register in a child process when module.registerHooks is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-node-version-stop-'));
    try {
      const stripPreload = join(dir, 'strip-register-hooks.cjs');
      const appEntry = join(dir, 'app.mjs');
      writeFileSync(
        stripPreload,
        `'use strict';\nconst Module = require('node:module');\nObject.defineProperty(Module, 'registerHooks', { value: undefined, configurable: true, writable: true });\n`,
      );
      writeFileSync(appEntry, `console.log('UNSWAPPED_APP_RAN');\n`);

      const res = spawnSync('node', ['--require', stripPreload, '--import', registerUrl, appEntry], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: undefined,
          PYRIC_SANDBOX: 'local',
        },
        timeout: 15_000,
      });

      expect(res.status).not.toBe(0);
      expect(res.stdout).not.toContain('UNSWAPPED_APP_RAN');
      expect(res.stderr).toContain('PYRIC_UNSUPPORTED_NODE_VERSION');
      expect(res.stderr).toContain('>= 22.15');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
