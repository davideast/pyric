import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const buildScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/build.sh');

for (const scenario of ['packages-success', 'packages-failure', 'full'] as const) test(`Studio assets after ${scenario}`, () => {
  const failCompilation = scenario === 'packages-failure';
  const packagesOnly = scenario !== 'full';
  const root = mkdtempSync(join(tmpdir(), 'packages-only-'));
  try {
    mkdirSync(join(root, 'scripts'));
    cpSync(buildScript, join(root, 'scripts/build.sh'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Compiler processes are the external boundary: exercise the real build
    // orchestration and cleanup without compiling the monorepo in this test.
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexit ${failCompilation ? 9 : 0}\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'jq'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = --cwd ]; then\n mkdir -p "$3/dist"\n echo rebuilt > "$3/dist/rebuilt"\n if [ "$3" = packages/site-docs ]; then echo fresh-site > "$3/dist/index.html"; fi\nfi\n', { mode: 0o755 });
    for (const pkg of ['pyric', 'pyric-admin', 'create-pyric', 'ui', 'cli', 'studio', 'site-docs']) {
      mkdirSync(join(root, 'packages', pkg, 'dist'), { recursive: true });
      writeFileSync(join(root, 'packages', pkg, 'package.json'), '{}');
    }
    const embedded = join(root, 'packages/cli/dist/serve/site-ui');
    mkdirSync(embedded, { recursive: true });
    writeFileSync(join(embedded, 'index.html'), 'built Studio');
    writeFileSync(join(root, 'packages/site-docs/dist/index.html'), 'built site');
    writeFileSync(join(root, 'packages/cli/dist/stale.js'), 'stale package output');
    const run = spawnSync('bash', ['scripts/build.sh', ...(packagesOnly ? ['--packages-only'] : [])], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(run.status).toBe(failCompilation ? 9 : 0);
    expect(existsSync(join(embedded, 'index.html'))).toBe(true);
    expect(readFileSync(join(embedded, 'index.html'), 'utf8').trim()).toBe(packagesOnly ? 'built Studio' : 'fresh-site');
    expect(readFileSync(join(root, 'packages/site-docs/dist/index.html'), 'utf8').trim()).toBe(packagesOnly ? 'built site' : 'fresh-site');
    expect(existsSync(join(root, 'packages/cli/dist/stale.js'))).toBe(false);
    if (!failCompilation) expect(readFileSync(join(root, 'packages/cli/dist/rebuilt'), 'utf8').trim()).toBe('rebuilt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
