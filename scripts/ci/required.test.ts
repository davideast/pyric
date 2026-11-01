import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFailures } from './required.ts';

const success = {
  'build-packages': 'success',
  'build-and-test': 'success',
  'library-tests': 'success',
  'conformance-suite': 'success',
  'browser-conformance': 'success',
  'conformance-gates': 'success',
  'native-conformance': 'success',
  'release-contract': 'skipped',
  packaging: 'skipped',
  'install-matrix': 'skipped',
  standalone: 'skipped',
};

describe('required CI result', () => {
  test('the aggregate job receives every result its packaging policy requires', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toEqual(
      expect.arrayContaining(['packaging', 'install-matrix', 'standalone']),
    );
  });

  test('only the experimental Kotlin client is non-blocking in native conformance', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const nativeJob = workflow.slice(workflow.indexOf('\n  native-conformance:'), workflow.indexOf('\n  required:'));
    expect(nativeJob).toContain('continue-on-error: ${{ matrix.blocking == false }}');
    const entries = [...nativeJob.matchAll(/- sdk: (\w+)\n\s+os: [\w-]+\n\s+blocking: (true|false)/g)]
      .map(([, sdk, blocking]) => [sdk, blocking]);
    expect(Object.fromEntries(entries)).toEqual({ kotlin: 'false', flutter: 'true', swift: 'true' });
    // Job-level `continue-on-error` alone still marks the GitHub Check Run red (`X`),
    // causing `gh pr checks` to exit 1. Kotlin steps must also carry step-level
    // `continue-on-error: true` while Flutter and Swift steps stay hard-failing.
    const kotlinStep = nativeJob.slice(nativeJob.indexOf('- name: Run Kotlin client tests'), nativeJob.indexOf('- name: Set up Flutter'));
    expect(kotlinStep).toContain('continue-on-error: true');
    const blockingSteps = nativeJob.slice(nativeJob.indexOf('- name: Set up Flutter'));
    expect(blockingSteps).not.toContain('continue-on-error: true');
  });

  test('accepts skipped jobs only when their check set did not select them', () => {
    expect(requiredFailures({ checkSet: 'full', requirePackaging: false, results: success })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'release-only',
      requirePackaging: false,
      results: { ...success, 'build-packages': 'skipped', 'build-and-test': 'skipped', 'library-tests': 'skipped', 'conformance-suite': 'skipped', 'browser-conformance': 'skipped', 'conformance-gates': 'skipped', 'native-conformance': 'skipped', 'release-contract': 'success' },
    })).toEqual([]);
  });

  test('requires the RTDB differential gate only when the plan selected it', () => {
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: false,
      results: { ...success, 'rtdb-differential': 'skipped' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: true,
      results: { ...success, 'rtdb-differential': 'skipped' },
    })).toEqual(['rtdb-differential: skipped']);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: true,
      results: { ...success, 'rtdb-differential': 'success' },
    })).toEqual([]);
  });

  test('the aggregate job receives the RTDB differential result and the plan\'s selection', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('rtdb-differential');
    expect(requiredJob).toContain('CI_REQUIRE_RTDB_DIFFERENTIAL: ${{ needs.plan.outputs.rtdb-differential }}');
  });

  test('requires the app scenarios only when the plan selected them', () => {
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: false,
      results: { ...success, 'app-scenarios': 'skipped' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: true,
      results: { ...success, 'pack-packages': 'success', 'app-scenarios': 'failure' },
    })).toEqual(['app-scenarios: failure']);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: true,
      results: { ...success, 'pack-packages': 'success', 'app-scenarios': 'success' },
    })).toEqual([]);
  });

  test('requires the one pack whenever the app scenarios or the packaging proof are selected', () => {
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: false,
      results: { ...success, 'pack-packages': 'skipped' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: true,
      results: { ...success, 'pack-packages': 'failure', 'app-scenarios': 'success' },
    })).toEqual(['pack-packages: failure']);
    const packaged = { ...success, packaging: 'success', 'install-matrix': 'success', standalone: 'success', 'release-contract': 'success' };
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: true, results: packaged,
    })).toEqual(['pack-packages: missing']);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: true, results: { ...packaged, 'pack-packages': 'success' },
    })).toEqual([]);
  });

  type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> };
  const parsedWorkflow = () => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8')) as {
    env?: Record<string, string>;
    jobs: Record<string, { needs?: string | string[]; steps?: Step[] }>;
  };
  const CHECK = 'node scripts/lib/proven-stamp.mjs check dist/packages .';

  test('the pack job is the only pack, and every tarball consumer checks its manifest', () => {
    const workflow = parsedWorkflow();
    const needsOf = (job: string) => [workflow.jobs[job]?.needs ?? []].flat();
    const runs = (job: string) => (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');
    const packers = Object.keys(workflow.jobs).filter((job) => runs(job).includes('scripts/pack-packages.sh'));
    expect(packers).toEqual(['pack-packages']);
    expect(runs('pack-packages')).toContain('bash scripts/pack-packages.sh --skip-build');
    expect(needsOf('required')).toContain('pack-packages');
    expect(needsOf('app-scenarios')).toContain('pack-packages');
    expect(needsOf('packaging')).toContain('pack-packages');
    for (const job of ['app-scenarios', 'packaging', 'install-matrix']) {
      const steps = workflow.jobs[job]?.steps ?? [];
      const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact') && step.with?.name === 'packed-packages');
      const check = steps.findIndex((step) => step.run === CHECK);
      const firstUse = steps.findIndex((step) => /dist\/packages|PYRIC_PACKAGE_ARTIFACT_DIR/.test(`${step.run ?? ''}`) && !step.run?.includes('proven-stamp.mjs check'));
      expect(download).toBeGreaterThanOrEqual(0);
      expect(check).toBeGreaterThan(download);
      expect(firstUse === -1 || firstUse > check).toBe(true);
    }
  });

  test('each consumer tests the downloaded tarballs, with no fallback to a pack of its own', () => {
    const workflow = parsedWorkflow();
    const steps = (job: string) => workflow.jobs[job]?.steps ?? [];
    const indexOf = (job: string, match: (step: Step) => boolean) => steps(job).findIndex(match);
    const checkAt = (job: string) => indexOf(job, (step) => step.run === CHECK);

    // packaging-test.sh without --packages builds and packs on its own.
    const gateRuns = steps('packaging').filter((step) => step.run?.includes('scripts/packaging-test.sh'));
    expect(gateRuns.map((step) => step.run)).toEqual(['bash scripts/packaging-test.sh --packages dist/packages']);
    expect(indexOf('packaging', (step) => step.run === gateRuns[0]?.run)).toBeGreaterThan(checkAt('packaging'));

    const appRuns = steps('app-scenarios').filter((step) => step.run?.includes('test/apps/run.ts'));
    expect(appRuns).toHaveLength(1);
    expect(appRuns[0]?.run).toContain('--packages dist/packages');
    expect(indexOf('app-scenarios', (step) => step.run === appRuns[0]?.run)).toBeGreaterThan(checkAt('app-scenarios'));

    // install-matrix.sh without PYRIC_PACKAGE_ARTIFACT_DIR packs when dist/packages has no manifest.
    const install = indexOf('install-matrix', (step) => step.run?.includes('scripts/install-matrix.sh') ?? false);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(steps('install-matrix')[install]?.env?.PYRIC_PACKAGE_ARTIFACT_DIR).toBe('dist/packages');
    expect(install).toBeGreaterThan(checkAt('install-matrix'));
  });

  test('the packed build is keyed on the pinned toolchain and built fresh on main and nightly', () => {
    const workflow = parsedWorkflow();
    const action = readFileSync(resolve(import.meta.dir, '../../.github/actions/restore-dist/action.yml'), 'utf8');
    expect(workflow.env?.BUN_VERSION).toBeTruthy();
    expect(workflow.env?.NODE_VERSION).toBeTruthy();
    // One pin: every job reads the versions from the workflow env.
    const raw = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    for (const line of raw.split('\n').filter((text) => /^\s+(bun|node)-version:/.test(text))) {
      expect(line).toMatch(/: \$\{\{ env\.(BUN|NODE)_VERSION \}\}$/);
    }
    const studioKeys = action.match(/key: dist-studio-.*$/gm) ?? [];
    expect(studioKeys).toHaveLength(2);
    for (const key of studioKeys) expect(key).toContain('steps.toolchain.outputs.toolchain');
    expect(action).toContain("if: inputs.flavor == 'studio' && inputs.fresh != 'true'");
    const build = (workflow.jobs['pack-packages']?.steps ?? []).find((step) => step.uses === './.github/actions/restore-dist');
    expect(build?.with?.flavor).toBe('studio');
    expect(build?.with?.fresh).toBe("${{ github.event_name == 'push' || github.event_name == 'schedule' }}");
  });

  test('the aggregate job receives the app scenario result and the plan\'s selection', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('app-scenarios');
    expect(requiredJob).toContain('CI_REQUIRE_APP_SCENARIOS: ${{ needs.plan.outputs.app-scenarios }}');
  });

  test('requires the removal guard on every pull request, whatever the check set', () => {
    for (const checkSet of ['full', 'release-only', 'docs-only'] as const) {
      expect(requiredFailures({
        checkSet, requirePackaging: false, requireDeletionGuard: true,
        results: { 'deletion-guard': 'failure' },
      })).toContain('deletion-guard: failure');
    }
    expect(requiredFailures({
      checkSet: 'docs-only', requirePackaging: false, requireDeletionGuard: true,
      results: { 'deletion-guard': 'success' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'docs-only', requirePackaging: false, requireDeletionGuard: false,
      results: { 'deletion-guard': 'skipped' },
    })).toEqual([]);
  });

  test('the aggregate job receives the removal guard result, required on pull requests', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('deletion-guard');
    expect(requiredJob).toContain("CI_REQUIRE_DELETION_GUARD: ${{ github.event_name == 'pull_request' }}");
  });

  test('rejects a skipped conformance-gates job on the full check set', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: { ...success, 'conformance-gates': 'skipped' },
    })).toEqual(['conformance-gates: skipped']);
  });

  test('ignores a missing or failed independent Playground result', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: success,
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: { ...success, 'playground-caniuse': 'failure' },
    })).toEqual([]);
  });

  test('does not require a build for authored-documentation-only changes', () => {
    expect(requiredFailures({
      checkSet: 'docs-only',
      requirePackaging: false,
      results: {},
    })).toEqual([]);
  });

  test('requires every packaging consumer (incl. the standalone smoke) when the packaging policy is active', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: true,
      results: success,
    })).toEqual(['packaging: skipped', 'install-matrix: skipped', 'standalone: skipped', 'release-contract: skipped', 'pack-packages: missing']);
  });
});
