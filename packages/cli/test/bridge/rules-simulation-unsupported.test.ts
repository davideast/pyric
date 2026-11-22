/**
 * Regression coverage for #1340: CLI `rules simulate` and `explainDenial`
 * surface `UNSUPPORTED` (with simulator notes, separate summary counts, and
 * exit status 2 on the CLI runner) instead of reporting `DENY` when the
 * simulator abstains on an unmodeled construct.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { parseArgs } from '../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../src/cli/surface-method-runner.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { simulateFirestoreCase } from '../../src/bridge/surface/rules-simulation.js';

const UNSUPPORTED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if foo.bar();
    }
    match /public/{id} {
      allow read: if true;
    }
    match /locked/{id} {
      allow read: if false;
    }
  }
}`;

const surface = renderSurface(undefined);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-sim-unsupported-'));
  tempDirs.push(dir);
  return dir;
}

describe('Firestore rules simulation and explainDenial on simulator abstention (#1340)', () => {
  it('simulateFirestoreCase counts unsupported cases apart from passes and failures', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, UNSUPPORTED_RULES);
    const ctx = createSurfaceContext(sandbox);

    const outcome = await simulateFirestoreCase(ctx, {
      operation: 'get',
      path: 'docs/d1',
      uid: 'alice',
    });

    expect(outcome.allowed).toBe(false);
    expect(outcome.unsupported).toBe(true);
    expect(outcome.decision).toBe('UNSUPPORTED');
    expect(outcome.result.summary).toBe('0/1 test cases passed (0 failed, 1 unsupported)');
  });

  it('rules.simulate reports UNSUPPORTED with the simulator note and keeps decision UNSUPPORTED in JSON', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, UNSUPPORTED_RULES);
    const ctx = createSurfaceContext(sandbox);
    const rulesTool = surface.tools.find((candidate) => candidate.name === 'rules')!;

    const single = await rulesTool.execute(
      {
        method: 'simulate',
        args: { service: 'firestore', operation: 'get', path: 'docs/d1', uid: 'alice' },
      },
      ctx,
    );

    expect(single.ok).toBe(false);
    expect(single.summary).toContain('get docs/d1: UNSUPPORTED');
    expect(single.summary).toContain("Unknown namespace or method 'foo.bar()'");
    expect(single.summary).not.toContain('DENY');

    const payload = single.data as {
      decision: string;
      allowed: boolean;
      unsupported: boolean;
      case: { decision: string; state: string };
    };
    expect(payload.decision).toBe('UNSUPPORTED');
    expect(payload.allowed).toBe(false);
    expect(payload.unsupported).toBe(true);
    expect(payload.case.decision).toBe('UNSUPPORTED');
    expect(payload.case.state).toBe('UNSUPPORTED');
  });

  it('rules.simulate batch counts allow, deny, and unsupported separately', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, UNSUPPORTED_RULES);
    const ctx = createSurfaceContext(sandbox);
    const rulesTool = surface.tools.find((candidate) => candidate.name === 'rules')!;

    const batch = await rulesTool.execute(
      {
        method: 'simulate',
        args: {
          service: 'firestore',
          cases: [
            { operation: 'get', path: 'public/p1', uid: 'alice' },
            { operation: 'get', path: 'locked/l1', uid: 'alice' },
            { operation: 'get', path: 'docs/d1', uid: 'alice' },
          ],
        },
      },
      ctx,
    );

    expect(batch.ok).toBe(false);
    expect(batch.summary).toBe('3 cases: 1 allow, 1 deny, 1 unsupported.');
    const cases = (batch.data as { cases: Array<{ path: string; allowed: boolean; unsupported?: boolean; summary: string }> }).cases;
    expect(cases.map((entry) => entry.unsupported ?? false)).toEqual([false, false, true]);
    expect(cases[2]?.summary).toContain('UNSUPPORTED');
  });

  it('rules.explainDenial says pyric cannot decide this request with the note and gives no deny reason', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, UNSUPPORTED_RULES);
    const ctx = createSurfaceContext(sandbox);
    const rulesTool = surface.tools.find((candidate) => candidate.name === 'rules')!;

    const explained = await rulesTool.execute(
      {
        method: 'explainDenial',
        args: { service: 'firestore', operation: 'get', path: 'docs/d1', uid: 'alice' },
      },
      ctx,
    );

    expect(explained.ok).toBe(true);
    expect(explained.summary).toBe(
      "pyric cannot decide this request: Unknown namespace or method 'foo.bar()'",
    );
    expect(explained.summary).not.toContain('is denied');
    const data = explained.data as { decision: string; allowed: boolean; case: { decision: string } };
    expect(data.decision).toBe('UNSUPPORTED');
    expect(data.allowed).toBe(false);
    expect(data.case.decision).toBe('UNSUPPORTED');
  });

  it('CLI pyric rules simulate exits 2 on UNSUPPORTED in both text and --json modes', async () => {
    const dir = freshTempDir();
    writeFileSync(join(dir, 'firestore.rules'), UNSUPPORTED_RULES, 'utf8');
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      'utf8',
    );

    let textStdout = '';
    let textStderr = '';
    const textCode = await runSurfaceMethod(
      'rules.simulate',
      parseArgs([
        'rules',
        'simulate',
        '--in-process',
        '--service',
        'firestore',
        '--operation',
        'get',
        '--path',
        'docs/d1',
      ]),
      {
        cwd: dir,
        stdout: { write: (chunk) => { textStdout += chunk; } },
        stderr: { write: (chunk) => { textStderr += chunk; } },
        discover: async () => [],
      },
    );

    expect(textCode).toBe(2);
    expect(textStdout).toContain('get docs/d1: UNSUPPORTED');
    expect(textStdout).toContain("Unknown namespace or method 'foo.bar()'");
    expect(textStdout).not.toContain('get docs/d1: DENY');

    let jsonStdout = '';
    const jsonCode = await runSurfaceMethod(
      'rules.simulate',
      parseArgs([
        'rules',
        'simulate',
        '--in-process',
        '--json',
        '--service',
        'firestore',
        '--operation',
        'get',
        '--path',
        'docs/d1',
      ]),
      {
        cwd: dir,
        stdout: { write: (chunk) => { jsonStdout += chunk; } },
        stderr: { write: () => {} },
        discover: async () => [],
      },
    );

    expect(jsonCode).toBe(2);
    const parsedJson = JSON.parse(jsonStdout) as {
      ok: boolean;
      summary: string;
      data: { decision: string; case: { decision: string } };
    };
    expect(parsedJson.ok).toBe(false);
    expect(parsedJson.summary).toContain('UNSUPPORTED');
    expect(parsedJson.data.decision).toBe('UNSUPPORTED');
    expect(parsedJson.data.case.decision).toBe('UNSUPPORTED');
  });
});
