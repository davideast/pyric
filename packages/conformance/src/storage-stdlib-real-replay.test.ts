import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStorageRules, evaluateStorageRules } from '../../pyric/src/storage/rules.ts';
import { injectProbeRules } from './run-storage-stdlib-real.ts';

const OBS_DIR = join(import.meta.dir, '..', 'observations', 'storage-rules');
const RUN_ID = 'local-replay';
const PREFIX = `__pyric_storage_stdlib/${RUN_ID}`;

function behavior(name: string): Record<string, 'ALLOW' | 'DENY'> {
  const value = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior?: Record<string, unknown>;
  };
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
