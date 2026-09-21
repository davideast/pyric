import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test('a real packed CLI installs with Vite 8 without overriding peer checks', () => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'pyric-vite-peer-'));
  try {
    const dependencies: Record<string, string> = { vite: '8.3.0' };
    for (const name of ['pyric', 'pyric-admin', 'create-pyric', 'cli']) {
      const packageRoot = join(repoRoot, 'packages', name);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], {
        cwd: packageRoot, encoding: 'utf8', timeout: 30_000,
      }));
      const archive = join(root, packed[0].filename);
      const staging = join(root, name);
      mkdirSync(staging);
      execFileSync('tar', ['-xzf', archive, '-C', staging]);
      execFileSync('node', [join(repoRoot, 'scripts/lib/rewrite-workspace-deps.mjs'), join(staging, 'package/package.json'), repoRoot]);
      execFileSync('tar', ['-czf', archive, '-C', staging, 'package']);
      dependencies[manifest.name] = `file:${archive}`;
    }
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
    const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: consumer, encoding: 'utf8', timeout: 120_000,
      // Do not inherit a developer's permissive npm setting into this proof.
      env: { ...process.env, npm_config_legacy_peer_deps: 'false', npm_config_force: 'false' },
    });
    expect(installed.status, installed.stderr).toBe(0);
    const tree = JSON.parse(execFileSync('npm', ['ls', 'vite', '@pyric/cli', '--json'], { cwd: consumer, encoding: 'utf8' }));
    expect(tree.dependencies.vite.version).toBe('8.3.0');
    const loaded = execFileSync('node', ['--input-type=module', '--eval', `
      import { pyric } from '@pyric/cli/vite';
      if (typeof pyric !== 'function') throw new Error('Missing Vite plugin export');
      console.log('loaded');
    `], { cwd: consumer, encoding: 'utf8', timeout: 30_000 });
    expect(loaded.trim()).toBe('loaded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
