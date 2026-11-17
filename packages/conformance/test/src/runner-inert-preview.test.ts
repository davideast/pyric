import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { loadRigManifests } from '../../rigs/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SRC_DIR = join(HERE, '..', '..', 'src');
const DOCS_DIR = join(HERE, '..', '..', 'docs');

/** Pure offline validation/projection/report/preflight CLIs under `src/` that are NOT capture runners. */
const NON_CAPTURE_CLI_SCRIPTS: ReadonlySet<string> = new Set([
  'packages/conformance/src/audit.ts',
  'packages/conformance/src/audit-gate.ts',
  'packages/conformance/src/census-gate.ts',
  'packages/conformance/src/check-messaging-provisioning.ts',
  'packages/conformance/src/check-observation-versions.ts',
  'packages/conformance/src/check-observations.ts',
  'packages/conformance/src/check-rtdb-preflight.ts',
  'packages/conformance/src/climb.ts',
  'packages/conformance/src/conformance-verdicts.ts',
  'packages/conformance/src/coverage.ts',
  'packages/conformance/src/entry-path-gate.ts',
  'packages/conformance/src/entry-path-symbols.ts',
  'packages/conformance/src/entry-path-validate.ts',
  'packages/conformance/src/firestore-rules-scorecard-gate.ts',
  'packages/conformance/src/generate-docs.ts',
  'packages/conformance/src/generate-projections.ts',
  'packages/conformance/src/plan.ts',
  'packages/conformance/src/print-fb-tag.ts',
  'packages/conformance/src/report.ts',
  'packages/conformance/src/rtdb-rules-scorecard-gate.ts',
  'packages/conformance/src/rules-language-capability.ts',
  'packages/conformance/src/rules-language-coverage.ts',
  'packages/conformance/src/rules-scorecard-gate.ts',
  'packages/conformance/src/storage-rules-scorecard-gate.ts',
  'packages/conformance/src/surface-census.ts',
  'packages/conformance/src/test-line-anchors.ts',
  'packages/conformance/src/validate-registry.ts',
]);

/** Shared helper modules that import `capture-mode-guard.ts` without being standalone CLI runners. */
const GUARD_HELPER_MODULES: ReadonlySet<string> = new Set([
  'packages/conformance/src/capture-mode-guard.ts',
  'packages/conformance/src/oracle-run-rtdb-probes.ts',
  'packages/conformance/src/oracle-run-setup.ts',
]);

function walkFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.endsWith('-fixture')) continue;
      out.push(...walkFiles(full, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

async function discoverCredentialedCaptureRunners(): Promise<string[]> {
  const rigManifests = await loadRigManifests();
  const unattendedRigScripts = new Set(
    rigManifests.filter((m) => m.automation === 'unattended').map((m) => m.script),
  );
  const credentialedRigScripts = rigManifests
    .filter((m) => m.automation === 'credentialed')
    .map((m) => m.script);

  const discovered = new Set<string>(credentialedRigScripts);
  for (const absPath of walkFiles(SRC_DIR, '.ts')) {
    const relPath = relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    if (unattendedRigScripts.has(relPath) || NON_CAPTURE_CLI_SCRIPTS.has(relPath)) continue;
    if (GUARD_HELPER_MODULES.has(relPath)) continue;
    const content = readFileSync(absPath, 'utf8');
    const isCliEntrypoint =
      content.startsWith('#!') ||
      content.includes('import.meta.main') ||
      content.includes('capture-mode-guard.ts') ||
      content.includes('runModularProbesCli(');
    if (isCliEntrypoint) {
      discovered.add(relPath);
    }
  }
  return [...discovered].sort();
}

const AMBIENT_TRAP_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  CI: '1',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent-ambient-cred-trap.json',
  PYRIC_ORACLE_SA_PATH: '/nonexistent-ambient-sa-trap.json',
  PYRIC_FUNCTIONS_RTDB_SA_PATH: '/nonexistent-ambient-fn-sa-trap.json',
  PYRIC_ORACLE_PROJECT_ID: 'digame-mas',
  PARITY_PROJECT_ID: 'digame-mas',
  PARITY_REQUIRE_CREDENTIAL: '1',
  PYRIC_ORACLE_FIREBASE_CONFIG:
    '{"apiKey":"trap","authDomain":"trap.firebaseapp.com","projectId":"digame-mas","databaseURL":"https://pyric-oracle-rtdb-2.firebaseio.com"}',
  PYRIC_AI_FIREBASE_CONFIG:
    '{"apiKey":"trap","appId":"1:123:web:abc","projectId":"digame-mas"}',
  PYRIC_MESSAGING_FIREBASE_CONFIG:
    '{"apiKey":"trap","appId":"1:123:web:abc","projectId":"digame-mas","messagingSenderId":"123"}',
  PYRIC_MESSAGING_VAPID_KEY: 'trap-vapid',
  PYRIC_STAGING_RTDB: 'https://trap-dedicated.firebaseio.com',
  PYRIC_STAGING_RTDB_NAMED: 'https://trap-named.firebaseio.com',
  PYRIC_STAGING_TOKEN: 'trap-token',
};

function buildStrippedCredentialEnv(emptyHome: string): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (
      key.startsWith('PYRIC_') ||
      key.startsWith('PARITY_') ||
      key.startsWith('GOOGLE_') ||
      key === 'GCLOUD_PROJECT' ||
      key === 'CLOUDSDK_CONFIG' ||
      key === 'XDG_CONFIG_HOME' ||
      key === 'FIREBASE_TOKEN'
    ) {
      continue;
    }
    clean[key] = val;
  }
  clean.CI = '1';
  clean.HOME = emptyHome;
  clean.XDG_CONFIG_HOME = join(emptyHome, '.config');
  clean.CLOUDSDK_CONFIG = join(emptyHome, '.gcloud');
  return clean;
}

describe('conformance capture runners inert-preview & credential-failure safety', () => {
  it('computes runner discovery dynamically over loadRigManifests() and src/ with zero stale exclusions', async () => {
    for (const excluded of NON_CAPTURE_CLI_SCRIPTS) {
      expect(existsSync(join(REPO_ROOT, excluded)), `stale exclusion ${excluded}`).toBe(true);
    }
    const runners = await discoverCredentialedCaptureRunners();
    expect(runners.length).toBeGreaterThanOrEqual(42);
    expect(runners).toContain('packages/conformance/src/capture/functions-rtdb/harness.ts');
    expect(runners).toContain('packages/conformance/src/capture/messaging-web/harness.ts');
    expect(runners).toContain('packages/conformance/src/capture/functions-http/harness.ts');
    expect(runners).toContain('packages/conformance/src/measure-stdlib-cost.ts');
    expect(runners).toContain('packages/conformance/src/replay-stdlib-cases.ts');
    expect(runners).toContain('packages/conformance/src/capture/admin-live/capture-admin-wire.ts');
    expect(runners).toContain('packages/conformance/src/capture/messaging-live/capture-m-wire.ts');
    expect(runners).toContain('packages/conformance/src/capture/rtdb-live/capture-a-wire.ts');
    expect(runners).toContain('packages/conformance/src/capture/rtdb-live/capture-b-bandwidth.ts');
    expect(runners).toContain('packages/conformance/src/capture/storage-live/capture-s-wire.ts');
    expect(runners).toContain('packages/conformance/src/capture/rtdb-disconnect/preflight.ts');
  });

  it(
    'prints an inert preview and exits 0 without reading ambient credentials when --write is omitted',
    async () => {
      const runners = await discoverCredentialedCaptureRunners();
      for (let i = 0; i < runners.length; i += 6) {
        const batch = runners.slice(i, i + 6);
        await Promise.all(
          batch.map(async (script) => {
            const proc = Bun.spawn(['bun', 'run', script], {
              cwd: REPO_ROOT,
              env: AMBIENT_TRAP_ENV,
              stdout: 'pipe',
              stderr: 'pipe',
            });
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            expect(exitCode, `${script} failed (${exitCode}): ${stderr}\n${stdout}`).toBe(0);
            expect(stdout.toLowerCase(), `${script} stdout missing inert/preview notice`).toMatch(
              /inert|preview|--write/,
            );
          }),
        );
      }
    },
    90_000,
  );

  it(
    'exits non-zero without printing INERT preview when --write is passed with missing credentials',
    async () => {
      const emptyHome = mkdtempSync(join(tmpdir(), 'pyric-empty-home-'));
      try {
        const strippedEnv = buildStrippedCredentialEnv(emptyHome);
        const runners = await discoverCredentialedCaptureRunners();
        for (let i = 0; i < runners.length; i += 6) {
          const batch = runners.slice(i, i + 6);
          await Promise.all(
            batch.map(async (script) => {
              const proc = Bun.spawn(['bun', 'run', script, '--write'], {
                cwd: REPO_ROOT,
                env: strippedEnv,
                stdout: 'pipe',
                stderr: 'pipe',
              });
              const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ]);
              expect(
                exitCode,
                `${script} --write unexpectedly exited 0:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
              ).not.toBe(0);
              const combined = `${stdout}\n${stderr}`.toLowerCase();
              expect(
                combined,
                `${script} --write printed inert preview instead of credential error:\n${stdout}\n${stderr}`,
              ).not.toContain('inert preview');
            }),
          );
        }
      } finally {
        rmSync(emptyHome, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it('contains zero --env-file instructions in conformance runner sources or docs', () => {
    const offenders: string[] = [];
    for (const file of [...walkFiles(SRC_DIR, '.ts'), ...walkFiles(DOCS_DIR, '.md')]) {
      if (!statSync(file).isFile()) continue;
      if (readFileSync(file, 'utf8').includes('--env-file')) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('includes explicit restore confirmation lines in run-firestore-real.ts and run-firestore-write-request-resource.ts', () => {
    const realSrc = readFileSync(join(SRC_DIR, 'run-firestore-real.ts'), 'utf8');
    const wrrSrc = readFileSync(join(SRC_DIR, 'run-firestore-write-request-resource.ts'), 'utf8');
    expect(realSrc).toContain('[firestore:real] firestore rules restored and verified');
    expect(wrrSrc).toContain('[write-request-resource] firestore rules restored and verified');
  });
});
