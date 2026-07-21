import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceScript = new URL('./deploy-site.sh', import.meta.url);
const repoRoot = new URL('../', import.meta.url);
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runDeployInFixture({ produceSite = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pyric-deploy-site-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  cpSync(sourceScript, join(root, 'scripts/deploy-site.sh'));
  writeFileSync(join(root, 'firebase.json'), '{"hosting":{"public":"dist/site"}}\n');

  const buildOutput = produceSite
    ? 'mkdir -p "$ROOT/dist/site"\ntouch "$ROOT/dist/site/index.html"'
    : ':';
  writeFileSync(
    join(root, 'scripts/build-site.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\nROOT="$(cd "$(dirname "$0")/.." && pwd)"\nprintf 'build-site\\n' >> "$TRACE"\n${buildOutput}\n`,
  );

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\nprintf \'bun %s\\n\' "$*" >> "$TRACE"\n');
  writeFileSync(
    join(root, 'node_modules/.bin/firebase'),
    '#!/usr/bin/env bash\nprintf \'firebase %s\\n\' "$*" >> "$TRACE"\n',
  );
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(root, 'node_modules/.bin/firebase'), 0o755);

  const trace = join(root, 'trace.log');
  const result = spawnSync('bash', ['scripts/deploy-site.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace },
  });
  return {
    result,
    trace: readFileSync(trace, 'utf8').trim().split('\n'),
  };
}

describe('deploy-site.sh', () => {
  test('builds the repo, composes the static site, then deploys only Hosting', () => {
    const { result, trace } = runDeployInFixture();

    expect(result.status).toBe(0);
    expect(trace).toEqual([
      'bun run build --packages-only',
      'build-site',
      'firebase deploy --only hosting',
    ]);
  });

  test('refuses to deploy when the static site entrypoint is missing', () => {
    const { result, trace } = runDeployInFixture({ produceSite: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/site/index.html');
    expect(trace).toEqual(['bun run build --packages-only', 'build-site']);
  });
});

describe('firebase.json hosting rewrites', () => {
  const firebaseJson = JSON.parse(readFileSync(new URL('firebase.json', repoRoot), 'utf8'));

  test('has no /docs/** (or other **) catch-all rewrite', () => {
    // A catch-all under /docs/** (or a bare `**`) turns any dead docs URL —
    // typo'd, removed, crawled by a stale link — into a 200'd app shell
    // instead of a real 404 (issue #375). The docs are pure static output
    // (Astro `directory` format: every page is its own <slug>/index.html),
    // so real docs URLs need no rewrite at all; Firebase Hosting serves
    // them, and dist/site/404.html, natively. Only the Studio SPA's own
    // client-routed tabs get scoped rewrites.
    const sources = firebaseJson.hosting.rewrites.map((rewrite) => rewrite.source);
    expect(sources).not.toContain('/docs/**');
    expect(sources).not.toContain('**');
  });

  test('scopes deep links to their finite Astro Studio entry documents', () => {
    for (const rewrite of firebaseJson.hosting.rewrites) {
      const match = rewrite.source.match(/^\/([a-z]+)\/\*\*$/);
      expect(match).not.toBeNull();
      expect(rewrite.destination).toBe(`/${match[1]}/index.html`);
    }
  });
});

describe('dist/site/404.html', () => {
  // The composed site build (`bash scripts/build-site.sh`) is not part of
  // this suite's `pretest` (packages-only). Skip when dist/site hasn't been
  // composed rather than failing the root suite; run `bash scripts/build.sh
  // --packages-only && bash scripts/build-site.sh` first to exercise this.
  const distSite = new URL('../dist/site/', import.meta.url);
  const built = existsSync(new URL('index.html', distSite));

  test.skipIf(!built)('is a real file Firebase Hosting serves for any dead path', () => {
    expect(existsSync(new URL('404.html', distSite))).toBe(true);
  });

  test.skipIf(!built)('stamps the worker generation only into finite Studio entries', () => {
    const manifest = JSON.parse(readFileSync(new URL('studio-routes.json', distSite), 'utf8'));
    for (const route of manifest.routes) {
      const path = route === 'home' ? 'index.html' : `${route}/index.html`;
      expect(readFileSync(new URL(path, distSite), 'utf8')).toMatch(
        /<meta name="pyric-worker-v" content="[a-f0-9]{16}">/,
      );
    }
    expect(readFileSync(new URL('docs/overview/index.html', distSite), 'utf8')).not.toContain(
      'pyric-worker-v',
    );
    expect(readFileSync(new URL('examples/firestore-first-write/index.html', distSite), 'utf8')).not.toContain(
      'pyric-worker-v',
    );
  });

  test.skipIf(!built)('ships the reserved static sandbox runtime beside Astro output', () => {
    expect(existsSync(new URL('__pyric/init.json', distSite))).toBe(true);
    expect(existsSync(new URL('__pyric/sdk/worker.js', distSite))).toBe(true);
    expect(existsSync(new URL('__pyric/sdk/init.js', distSite))).toBe(true);
  });
});
