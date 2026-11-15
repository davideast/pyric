import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';
import { pyric } from '../../src/serve/vite-plugin.js';

interface RemoteStampReport {
  failure?: string;
  closeFailure?: string;
  remote?: { status: number; body: string };
  local?: { status: number; body: string };
}

describe('Vite plugin', () => {
  it('keeps production builds on Firebase when hosted development is enabled', () => {
    const plugin = pyric({ hosted: true });
    const applies = plugin.apply;
    const hasNoApplyHook = typeof applies !== 'function';
    if (hasNoApplyHook) throw new Error('The plugin has no apply hook');
    expect(applies({}, { command: 'build', mode: 'production' })).toBe(false);
    expect(applies({}, { command: 'serve', mode: 'development' })).toBe(true);
  });

  it('configures server watch ignores for pyric runtime directory', () => {
    const plugin = pyric();
    if (!plugin.config) {
      throw new Error('pyric() plugin did not return a config hook');
    }
    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
    const result = configHook({}, { command: 'serve', mode: 'development' }) as UserConfig;
    expect(result.server?.watch?.ignored).toContain('**/.pyric/**');
  });

  it('denies .pyric to the dev server and keeps Vite\'s default deny list when the project sets none (#1779)', () => {
    const plugin = pyric({ hosted: true });
    if (!plugin.config) throw new Error('pyric() plugin did not return a config hook');
    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
    const result = configHook({}, { command: 'serve', mode: 'development' }) as UserConfig;
    expect(result.server?.fs?.deny).toEqual(['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.pyric/**']);
  });

  it('adds only its .pyric entry to a deny list the project sets, which Vite concatenates', () => {
    const plugin = pyric({ hosted: true });
    if (!plugin.config) throw new Error('pyric() plugin did not return a config hook');
    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
    const project: UserConfig = { server: { fs: { deny: ['secrets/**'] } } };
    const result = configHook(project, { command: 'serve', mode: 'development' }) as UserConfig;
    expect(result.server?.fs?.deny).toEqual(['**/.pyric/**']);
    expect(mergeConfig(project, result).server?.fs?.deny).toEqual(['secrets/**', '**/.pyric/**']);
  });

  it('emits a one-time deprecation warning when PYRIC_GUARD is set in standalone Vite config', () => {
    const warnedKey = Symbol.for('pyric.deprecatedGuardEnvWarned');
    const savedGuard = process.env.PYRIC_GUARD;
    const savedWarned = (globalThis as Record<symbol, unknown>)[warnedKey];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.env.PYRIC_GUARD = 'off';
    delete (globalThis as Record<symbol, unknown>)[warnedKey];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const plugin = pyric();
      const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config!.handler;
      configHook({}, { command: 'serve', mode: 'development' });
      configHook({}, { command: 'serve', mode: 'development' });
    } finally {
      process.stderr.write = originalWrite;
      if (savedGuard === undefined) delete process.env.PYRIC_GUARD;
      else process.env.PYRIC_GUARD = savedGuard;
      if (savedWarned === undefined) delete (globalThis as Record<symbol, unknown>)[warnedKey];
      else (globalThis as Record<symbol, unknown>)[warnedKey] = savedWarned;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PYRIC_GUARD is deprecated and ignored');
  });

  it('defines a non-sensitive hosted worker init fallback in config and preserves a user define', () => {
    const plugin = pyric({ hosted: true });
    if (!plugin.config) throw new Error('pyric() plugin did not return a config hook');
    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
    const result = configHook({}, { command: 'serve', mode: 'development' }) as UserConfig;
    const defined = result.define?.['process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT'];
    expect(typeof defined).toBe('string');
    const parsed = JSON.parse(JSON.parse(defined as string) as string) as Record<string, unknown>;
    expect(parsed).toEqual({ hosted: true, projectKey: null, bridgeUrl: null });

    const userValue = JSON.stringify(JSON.stringify({ hosted: true, projectKey: 'user-project', bridgeUrl: '/__pyric/sandbox' }));
    const userConfig: UserConfig = { define: { 'process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT': userValue } };
    const withUserDefine = configHook(userConfig, { command: 'serve', mode: 'development' }) as UserConfig;
    expect(withUserDefine.define?.['process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT']).toBeUndefined();
    expect(mergeConfig(userConfig, withUserDefine).define?.['process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT']).toBe(userValue);
  });

  it('stamps a non-sensitive hosted Node declaration for remote peers without leaking sessionToken or projectKey', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-remote-stamp-')));
    const root = join(parent, 'app');
    try {
      mkdirSync(root);
      symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      writeFileSync(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
      writeFileSync(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>items</title></head><body></body></html>');
      writeFileSync(join(root, 'vite.config.mjs'), [
        "import { pyric } from '@pyric/cli/vite';",
        'export default { plugins: [pyric({ hosted: true, ui: false })] };',
        '',
      ].join('\n'));

      const script = new URL('./fixtures/vite-remote-stamp-check.mjs', import.meta.url).pathname;
      const run = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [script, root], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (run.status !== 0) {
        throw new Error(`Vite remote stamp fixture failed (${run.status}): ${run.stderr}`);
      }
      const line = run.stdout.trim().split('\n').at(-1) ?? '';
      const report = JSON.parse(line) as RemoteStampReport;
      expect(report.failure).toBeUndefined();
      expect(report.closeFailure).toBeUndefined();

      const remoteHtml = report.remote?.body ?? '';
      expect(report.remote?.status).toBe(200);
      expect(remoteHtml).toContain('"hosted":true');
      expect(remoteHtml).toContain('<meta name="pyric-sandbox-host" content="node" data-pyric-serve>');
      expect(remoteHtml).not.toContain('"sessionToken"');
      expect(remoteHtml).not.toContain('data-project-key=');
      expect(remoteHtml).not.toContain(root);

      const localHtml = report.local?.body ?? '';
      expect(report.local?.status).toBe(200);
      expect(localHtml).toContain('"hosted":true');
      expect(localHtml).toContain('data-project-key=');
      expect(localHtml).toContain('"sessionToken"');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
