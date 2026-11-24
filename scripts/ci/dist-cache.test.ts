import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeProjectionOutputs } from '../../packages/conformance/src/generate-projections.ts';

const root = resolve(import.meta.dir, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
const action = readFileSync(resolve(root, '.github/actions/restore-dist/action.yml'), 'utf8');
const keyScript = readFileSync(resolve(root, 'scripts/ci/build-input-key.sh'), 'utf8');
const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf8');

function jobBlock(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = workflow.slice(start + 1).search(/\n  [a-z-]+:/);
  return end < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + end);
}

describe('CI dist cache', () => {
  test('every always-on job that needs the build goes through restore-dist', () => {
    for (const id of [
      'build-packages',
      'build-and-test',
      'library-tests',
      'conformance-suite',
      'conformance-gates',
      'browser-conformance',
      'docs-tests',
    ]) {
      expect(jobBlock(id)).toContain('uses: ./.github/actions/restore-dist');
    }
    // The composite owns every build invocation; a job calling build.sh
    // directly would bypass the cache and drift from the keyed inputs.
    expect(workflow.match(/run: bash scripts\/build\.sh/g)).toBeNull();
  });

  test('the cache is exact-match only (no restore-keys)', () => {
    // A near-miss restore would run tests against stale artifacts. Fail
    // closed: exact key or full rebuild.
    expect(action).not.toContain('restore-keys:');
  });

  test('the cache captures every gitignored generated source the build emits', () => {
    const generated = [
      'packages/cli/src/assurance/.generated',
      'packages/cli/src/conformance/.generated',
      'packages/cli/src/cli/service-commands.generated.ts',
      'packages/cli/src/bridge/tool-families.generated.ts',
      'packages/cli/src/bridge/surface/manifest.generated.ts',
      'packages/cli/src/bridge/surface/manifest.sandbox.generated.ts',
      'packages/cli/src/bridge/surface/descriptions.generated.ts',
    ];
    for (const path of generated) {
      expect(gitignore).toContain(path);
      expect(action).toContain(path);
    }
  });

  test('the key covers build inputs and excludes non-inputs', () => {
    for (const included of ["'packages/'", "'scripts/build.sh'", "'bun.lock'"]) {
      expect(keyScript).toContain(included);
    }
    for (const excluded of ["':(glob,exclude)packages/*/test/**'", "':!packages/playground'"]) {
      expect(keyScript).toContain(excluded);
    }
    // The site flavor's key must also see the compose pipeline.
    expect(keyScript).toContain("'scripts/build-site.sh'");
    expect(keyScript).toContain("'scripts/site/'");
  });

  test('CLI prebuild writes only gitignored ephemeral projections and skips tracked capabilities (#1417)', () => {
    const cliManifest = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(cliManifest.scripts?.prebuild).toContain('generate-projections.ts --write --ephemeral');

    const dir = mkdtempSync(join(tmpdir(), 'projection-outputs-'));
    try {
      const ephemeralPath = join(dir, '.generated/can-i-use.ts');
      const trackedPath = join(dir, 'tracked/rules-capabilities.generated.ts');
      writeFileSync(resolve(dir, 'sentinel.txt'), 'ok');
      const entries = [
        { path: ephemeralPath, source: 'export const x = 1;\n', ephemeral: true },
        { path: trackedPath, source: 'export const cap = 1;\n', ephemeral: false },
      ];

      expect(writeProjectionOutputs(entries, { ephemeralOnly: true })).toEqual([ephemeralPath]);
      expect(readFileSync(ephemeralPath, 'utf8')).toBe('export const x = 1;\n');
      expect(writeProjectionOutputs(entries, { ephemeralOnly: true })).toEqual([]);

      expect(writeProjectionOutputs(entries, { ephemeralOnly: false })).toEqual([trackedPath]);
      expect(readFileSync(trackedPath, 'utf8')).toBe('export const cap = 1;\n');
      expect(writeProjectionOutputs(entries, { ephemeralOnly: false })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
