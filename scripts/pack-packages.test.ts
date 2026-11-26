import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FIREBASE_TESTED_AGAINST } from '../packages/cli/src/version/compat-target.ts';
import { resolvedAdminVersion } from '../packages/conformance/src/package-version.ts';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from './lib/private-job-tmpdir.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACK_SCRIPT = join(REPO_ROOT, 'scripts', 'pack-packages.sh');
const PACKAGING_TEST_SCRIPT = join(REPO_ROOT, 'scripts', 'packaging-test.sh');
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    removePrivateJobTmpDir(dir);
  }
});

function createWorkDir(label: string): string {
  const root = createPrivateJobTmpDir(label);
  tempRoots.push(root);
  return root;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hashPackedTarballs(outDir: string): Record<string, string> {
  const files = readdirSync(outDir)
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = sha256File(join(outDir, file));
  }
  return hashes;
}

function parseOctalField(text: string): number {
  if (text.length === 0) return 0;
  return Number.parseInt(text, 8);
}

function readTarHeaders(tgzPath: string): Array<{
  path: string;
  mode: string;
  uid: string;
  gid: string;
  mtime: number;
  uname: string;
  gname: string;
}> {
  const raw = gunzipSync(readFileSync(tgzPath));
  const entries: Array<{
    path: string;
    mode: string;
    uid: string;
    gid: string;
    mtime: number;
    uname: string;
    gname: string;
  }> = [];
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    let fullPath = name;
    if (prefix.length > 0) {
      fullPath = `${prefix}/${name}`;
    }
    const mode = header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim();
    const uid = header.subarray(108, 116).toString('ascii').replace(/\0.*$/, '').trim();
    const gid = header.subarray(116, 124).toString('ascii').replace(/\0.*$/, '').trim();
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const mtimeText = header.subarray(136, 148).toString('ascii').replace(/\0.*$/, '').trim();
    const uname = header.subarray(265, 297).toString('utf8').replace(/\0.*$/, '');
    const gname = header.subarray(297, 329).toString('utf8').replace(/\0.*$/, '');
    const size = parseOctalField(sizeText);
    const mtime = parseOctalField(mtimeText);
    entries.push({ path: fullPath, mode, uid, gid, mtime, uname, gname });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Stubs `npm pack` so `pack-packages.sh --skip-build` exercises its real root-README
 * copy, `rewrite-workspace-deps.mjs`, sourcemap check, and `repack_deterministic`
 * across all 7 workspace packages even when `npm` injects varying mtimes/owners/modes.
 */
function writeNonDeterministicNpmPackStub(binDir: string, mtimeSeconds: number, fileMode: string): void {
  const npmStub = join(binDir, 'npm');
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "pack" ]; then
  dest="$4"
  name=$(jq -r .name package.json)
  version=$(jq -r .version package.json)
  flat="\${name#@}"
  flat="\${flat//\\//-}"
  file="\${flat}-\${version}.tgz"
  tmp=$(mktemp -d)
  mkdir -p "$tmp/package/dist/sub"
  cp package.json "$tmp/package/package.json"
  printf 'export const ok = 1;\\n' > "$tmp/package/dist/index.js"
  printf 'export const nested = 2;\\n' > "$tmp/package/dist/sub/feature.js"
  printf 'export const extra = 3;\\n' > "$tmp/package/dist/sub-extra.js"
  printf '#!/usr/bin/env node\\nconsole.log(1);\\n' > "$tmp/package/dist/cli.js"
  chmod "${fileMode}" "$tmp/package/package.json" "$tmp/package/dist/index.js" "$tmp/package/dist/sub/feature.js" "$tmp/package/dist/sub-extra.js"
  chmod 0755 "$tmp/package/dist/cli.js"
  touch -d "@${String(mtimeSeconds)}" "$tmp/package" "$tmp/package/package.json" "$tmp/package/dist" "$tmp/package/dist/index.js" "$tmp/package/dist/sub" "$tmp/package/dist/sub/feature.js" "$tmp/package/dist/sub-extra.js" "$tmp/package/dist/cli.js" 2>/dev/null || true
  tar -czf "$dest/$file" -C "$tmp" package
  rm -rf "$tmp"
  echo "$file"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 64
`;
  writeFileSync(npmStub, script);
  chmodSync(npmStub, 0o755);
}

describe('scripts/pack-packages.sh determinism (#1615)', () => {
  test('produces byte-identical tarballs for all 7 packages across differing timestamps and umasks', () => {
    const work = createWorkDir('pack-det');
    const binA = join(work, 'bin-a');
    const binB = join(work, 'bin-b');
    const outA = join(work, 'out-a');
    const outB = join(work, 'out-b');
    mkdirSync(binA, { recursive: true });
    mkdirSync(binB, { recursive: true });
    mkdirSync(outA, { recursive: true });
    mkdirSync(outB, { recursive: true });

    writeNonDeterministicNpmPackStub(binA, 1_700_000_001, '0644');
    writeNonDeterministicNpmPackStub(binB, 1_750_000_999, '0600');

    const runA = spawnSync(
      '/bin/bash',
      ['-c', `umask 0022 && bash "${PACK_SCRIPT}" --skip-build --out "${outA}"`],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${binA}:${process.env.PATH}` } },
    );
    expect(runA.status).toBe(0);

    // Touch root README mtime is avoided on the working tree; differing umask (0077)
    // and differing upstream tarball timestamps/modes exercise every non-deterministic path.
    const runB = spawnSync(
      '/bin/bash',
      ['-c', `umask 0077 && bash "${PACK_SCRIPT}" --skip-build --out "${outB}"`],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${binB}:${process.env.PATH}` } },
    );
    expect(runB.status).toBe(0);

    const hashesA = hashPackedTarballs(outA);
    const hashesB = hashPackedTarballs(outB);
    expect(Object.keys(hashesA)).toHaveLength(7);
    expect(hashesA).toEqual(hashesB);

    // Inspect a repacked tarball (pyric gets root README + workspace rewrite) to verify
    // normalized USTAR metadata and sorted entry order.
    const pyricTgzName = Object.keys(hashesA).find((name) => /^pyric-\d/.test(name));
    expect(pyricTgzName).toBeDefined();
    if (pyricTgzName === undefined) return;
    const fullPyricTgz = join(outA, pyricTgzName);
    const gzBytes = readFileSync(fullPyricTgz);
    expect([...gzBytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(gzBytes[9]).toBe(0xff);

    const headers = readTarHeaders(fullPyricTgz);
    const paths = headers.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    for (const entry of headers) {
      expect(entry.mtime).toBe(499162500);
      expect(entry.uid).toBe('0000000');
      expect(entry.gid).toBe('0000000');
      expect(entry.uname).toBe('');
      expect(entry.gname).toBe('');
      const expectedMode = entry.path.endsWith('/cli.js') ? '0000755' : '0000644';
      expect(entry.mode).toBe(expectedMode);
    }
  }, 30_000);

  test('splits paths between 101 and 255 bytes into USTAR prefix + name deterministically', () => {
    const work = createWorkDir('pack-long');
    const bin = join(work, 'bin');
    const outA = join(work, 'out-a');
    const outB = join(work, 'out-b');
    mkdirSync(bin, { recursive: true });
    mkdirSync(outA, { recursive: true });
    mkdirSync(outB, { recursive: true });

    const longDir = 'dist/deeply-nested-directory-segment-one/deeply-nested-directory-segment-two/deeply-nested-segment-three';
    const npmStub = join(bin, 'npm');
    writeFileSync(
      npmStub,
      `#!/usr/bin/env bash
set -euo pipefail
dest="$4"
name=$(jq -r .name package.json)
version=$(jq -r .version package.json)
file="\${name#@}"
file="\${file//\\//-}-\${version}.tgz"
tmp=$(mktemp -d)
mkdir -p "$tmp/package/${longDir}"
cp package.json "$tmp/package/package.json"
printf 'export const deep = true;\\n' > "$tmp/package/${longDir}/module-entry-file.js"
tar -czf "$dest/$file" -C "$tmp" package
rm -rf "$tmp"
echo "$file"
`,
    );
    chmodSync(npmStub, 0o755);

    const first = spawnSync('/bin/bash', [PACK_SCRIPT, '--skip-build', '--package', 'rules', '--out', outA], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(first.status).toBe(0);
    const rulesTgz = readdirSync(outA).find((name) => name.endsWith('.tgz'));
    expect(rulesTgz).toBeDefined();
    if (rulesTgz === undefined) return;
    const pastDate = new Date('2024-01-02T03:04:05Z');
    utimesSync(join(outA, rulesTgz), pastDate, pastDate);

    const second = spawnSync('/bin/bash', [PACK_SCRIPT, '--skip-build', '--package', 'rules', '--out', outB], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(second.status).toBe(0);
    expect(hashPackedTarballs(outA)).toEqual(hashPackedTarballs(outB));

    const headers = readTarHeaders(join(outA, rulesTgz));
    expect(headers.map((entry) => entry.path)).toContain(`package/${longDir}/module-entry-file.js`);
  }, 30_000);
});

describe('scripts/packaging-test.sh certified Firebase pins (#1225)', () => {
  test('Phase 3 consumer manifest pins FIREBASE_TESTED_AGAINST and resolvedAdminVersion dynamically', () => {
    const work = createWorkDir('pkg-pins');
    const bin = join(work, 'bin');
    const packages = join(work, 'packages');
    const tmpDir = join(work, 'tmp');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packages, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    writeNonDeterministicNpmPackStub(bin, 1_700_000_000, '0644');
    const packed = spawnSync('/bin/bash', [PACK_SCRIPT, '--skip-build', '--out', packages], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(packed.status).toBe(0);

    // Stub Phase 2 helpers and intercept Phase 3's first `npm install` to inspect
    // the generated consumer/package.json without running a registry install in unit tests.
    const capturedManifest = join(work, 'captured-consumer-package.json');
    writeFileSync(
      join(bin, 'bash'),
      `#!/bin/bash
if [[ "\${1:-}" == *manifest-lint.sh ]]; then exit 0; fi
exec /bin/bash "$@"
`,
    );
    chmodSync(join(bin, 'bash'), 0o755);

    const realNode = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/bash
if [[ "\${1:-}" == *check-declaration-deps.mjs ]] || [[ "\${1:-}" == *check-live-release.mjs ]]; then exit 0; fi
exec "${realNode}" "$@"
`,
    );
    chmodSync(join(bin, 'node'), 0o755);

    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/bash
if [ "\${1:-}" = "install" ]; then
  cp package.json "${capturedManifest}"
  exit 42
fi
exit 64
`,
    );
    chmodSync(join(bin, 'npm'), 0o755);

    // Populate minimum expected runtime assets so Phase 2.5 passes cleanly up to Phase 3.
    const populateTarball = (tgzFile: string, extraFiles: string[]) => {
      const stage = join(work, `stage-${tgzFile}`);
      mkdirSync(join(stage, 'package'), { recursive: true });
      spawnSync('tar', ['-xzf', join(packages, tgzFile), '-C', stage], { encoding: 'utf8' });
      for (const rel of extraFiles) {
        const target = join(stage, 'package', rel);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(target, '// stub\n');
      }
      spawnSync('tar', ['-czf', join(packages, tgzFile), '-C', stage, 'package'], { encoding: 'utf8' });
    };
    const tgzByPrefix = (prefix: string): string => {
      const found = readdirSync(packages).find((name) => name.startsWith(prefix) && name.endsWith('.tgz'));
      if (found === undefined) throw new Error(`missing tarball for ${prefix}`);
      return found;
    };
    populateTarball(tgzByPrefix('pyric-rules-'), [
      'dist/grammar/FirestoreRules.ohm',
      'dist/rtdb/grammar/RtdbExpr.ohm',
      'dist/modules/stdlib/math.rules',
    ]);
    populateTarball(tgzByPrefix('create-pyric-'), [
      'dist/bin.js',
      'templates/chat/src/ui/chat/chat-page.tsx',
      'templates/chat/src/firebase-messaging-sw.ts',
      'templates/chat/README.md',
      'templates/chat/.env.example',
      'templates/chat/stubs/empty-native-optional/package.json',
    ]);
    populateTarball(tgzByPrefix('pyric-cli-'), [
      'dist/cli/index.js',
      'dist/serve/site-ui/index.html',
      'dist/serve/site-ui/studio-routes.json',
      'dist/serve/site-ui/docs/index.html',
      'dist/serve/site-ui/_astro/app.js',
      'dist/serve/site-ui/_astro/app.css',
      'dist/serve/entries/app.js',
      'dist/serve/entries/auth.js',
      'dist/serve/entries/firestore.js',
      'dist/serve/entries/database.js',
      'dist/serve/entries/storage.js',
      'dist/serve/entries/init.js',
      'dist/serve/runtime/chip.js',
      'dist/serve/runtime/chip-install.js',
      'dist/serve/runtime/chip-config.js',
    ]);

    const gate = spawnSync('/bin/bash', [PACKAGING_TEST_SCRIPT, '--packages', packages], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmpDir },
    });
    expect(gate.status).toBe(42);

    const consumerManifest = JSON.parse(readFileSync(capturedManifest, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const chatFunctions = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/create-pyric/templates/chat/functions/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    expect(consumerManifest.dependencies.firebase).toBe(FIREBASE_TESTED_AGAINST);
    expect(consumerManifest.dependencies['firebase-admin']).toBe(resolvedAdminVersion());
    expect(consumerManifest.dependencies['firebase-functions']).toBe(chatFunctions.dependencies['firebase-functions']);
  }, 30_000);
});
