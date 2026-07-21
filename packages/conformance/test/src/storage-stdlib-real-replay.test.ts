import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStorageRules } from '../../../pyric/src/storage/sandbox/rules.ts';
import { evaluateStorageRules } from '../../../pyric/src/storage/sandbox/rules-evaluator.ts';
import {
  injectProbeRules,
  storageStdlibRealProbeBlockDigest,
} from '../../src/run-storage-stdlib-real.ts';
import { storageStdlibRemainingProbeBlockDigest } from '../../src/run-storage-stdlib-remaining.ts';

const OBS_DIR = join(import.meta.dir, '..', '..', 'observations', 'storage-rules');
const LOCK_DIR = join(import.meta.dir, '..', '..', 'probe-source-locks');
const RUN_ID = 'local-replay';
const PREFIX = `__pyric_storage_stdlib/${RUN_ID}`;

function observation(name: string): {
  behavior?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior?: Record<string, unknown>;
  };
}

function sourceLock(name: string): {
  basis: string;
  observation: string;
  scope: string;
  sha256: string;
} {
  return JSON.parse(readFileSync(join(LOCK_DIR, `${name}.json`), 'utf8'));
}

function behavior(name: string): Record<string, 'ALLOW' | 'DENY'> {
  const value = observation(name);
  const result: Record<string, 'ALLOW' | 'DENY'> = {};
  for (const [key, verdict] of Object.entries(value.behavior ?? {})) {
    if (verdict !== 'ALLOW' && verdict !== 'DENY') {
      throw new Error(`${name}: invalid captured verdict for ${key}: ${String(verdict)}`);
    }
    result[key] = verdict;
  }
  return result;
}

function verdicts(advanced: boolean, families: string[]): Record<string, 'ALLOW' | 'DENY'> {
  const source = injectProbeRules(
    "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { } }",
    RUN_ID,
    advanced,
  );
  const rules = parseStorageRules(source);
  const docs: Record<string, Record<string, unknown>> = {
    [`${PREFIX}/docs/a`]: {
      allow: true,
      count: 7,
      nested: { flag: true },
      tags: ['alpha', 'beta'],
    },
    [`${PREFIX}/docs/b`]: { allow: true },
    [`${PREFIX}/docs/c`]: { allow: true },
  };
  const lookup = {
    get: (path: string) => docs[path] ?? null,
    exists: (path: string) => Object.hasOwn(docs, path),
  };

  return Object.fromEntries(families.map((family) => {
    const result = evaluateStorageRules(
      rules,
      {
        request: {
          auth: null,
          method: 'create',
          path: `b/test/o/${PREFIX}/${family}/payload.bin`,
          resource: { size: 1 },
        },
        resource: null,
      },
      new Date('2026-07-21T00:00:00Z'),
      lookup,
    );
    return [family, result.allowed ? 'ALLOW' : 'DENY'];
  }));
}

describe('real-resource Storage stdlib observation replay', () => {
  it('locks every row 131 observation to its reconstructed injected probe block', () => {
    const cases = [
      ['stdlib-realstorage-p3-lookup-budget-iam-enabled', storageStdlibRealProbeBlockDigest(false), 'normalized-probe-rules-with-canonical-wrapper'],
      ['stdlib-realstorage-p3-advanced-iam-enabled', storageStdlibRealProbeBlockDigest(true), 'normalized-probe-rules-with-canonical-wrapper'],
      ['stdlib-realstorage-p3-named-database', storageStdlibRemainingProbeBlockDigest(), 'normalized-injected-probe-block-only'],
      ['stdlib-realstorage-p3-project-isolation', storageStdlibRemainingProbeBlockDigest(), 'normalized-injected-probe-block-only'],
    ] as const;
    for (const [name, digest, scope] of cases) {
      const lock = sourceLock(name);
      expect(lock).toMatchObject({
        observation: name,
        scope,
        basis: 'reviewed-reconstruction-from-historical-capture-code',
        sha256: digest,
      });
    }
  });

  it('replays the IAM-enabled lookup budget and caching matrix locally', () => {
    const observed = behavior('stdlib-realstorage-p3-lookup-budget-iam-enabled');
    const families = ['one', 'two', 'three', 'repeat', 'get-exists', 'short', 'missing-exists', 'missing-get'];
    expect(verdicts(false, families)).toEqual(Object.fromEntries(families.map((key) => [key, observed[key]])));
  });

  it('replays the locally decidable advanced lookup matrix', () => {
    const observed = behavior('stdlib-realstorage-p3-advanced-iam-enabled');
    const families = [
      'existing-get',
      'absent-field',
      'wrong-type',
      'nested-map',
      'list-membership',
      'auth-interpolation',
      'named-database',
      'false-or',
      'true-ternary',
      'helper',
      'let-binding',
      'error-or-true',
      'false-and-error',
    ];
    expect(verdicts(true, families)).toEqual(Object.fromEntries(families.map((key) => [key, observed[key]])));
  });
});
