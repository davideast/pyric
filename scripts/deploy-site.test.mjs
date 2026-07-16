import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
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
