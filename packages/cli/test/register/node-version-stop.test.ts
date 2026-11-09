import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UNSUPPORTED_NODE_VERSION_CODE,
  createUnsupportedNodeVersionError,
  requireRegisterHooks,
} from '../../src/register/node-version-stop.js';

const cliRoot = resolve(import.meta.dir, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;

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
    expect(caught!.code).toBe(UNSUPPORTED_NODE_VERSION_CODE);
    expect(caught!.message).toContain('@pyric/cli/register');
    expect(caught!.message).toContain('22.14.0');
    expect(caught!.message).toContain('>= 22.15');
    expect(caught!.message).toContain("require('firebase-admin')");
    expect(caught!.message).toContain('PYRIC_UNSUPPORTED_NODE_VERSION');
    expect(lines).toEqual([`${caught!.message}\n`]);
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
