import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  isParamExpression,
  resolveParamExpression,
} from '../../src/functions/params-resolver.js';

const requireFromConformance = createRequire(
  resolve(import.meta.dir, '../../../conformance/package.json'),
);
const params = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');
const paramsTypesPath = join(
  dirname(requireFromConformance.resolve('firebase-functions/params')),
  'types.js',
);
const paramsTypes = requireFromConformance(paramsTypesPath) as {
  transform: (source: unknown, fn: (val: string) => string) => unknown;
};
const optionsV2 = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');

describe('firebase-functions/params expression resolver', () => {
  test('resolves defineString, defineBoolean, defineInt, defineFloat, and defineList from env and defaults', () => {
    const strParam = params.defineString('STR_P', { default: 'fallback-str' });
    const boolParam = params.defineBoolean('BOOL_P', { default: true });
    const intParam = params.defineInt('INT_P', { default: 42 });
    const floatParam = params.defineFloat('FLOAT_P', { default: 2.5 });
    const listParam = params.defineList('LIST_P', { default: ['us-central1'] });
    const unsetStr = params.defineString('UNSET_STR');

    expect(resolveParamExpression(strParam, {})).toEqual({
      ok: true,
      value: 'fallback-str',
      containsSecret: false,
    });
    expect(resolveParamExpression(strParam, { STR_P: 'override' })).toEqual({
      ok: true,
      value: 'override',
      containsSecret: false,
    });
    expect(resolveParamExpression(strParam, { STR_P: '' })).toEqual({
      ok: true,
      value: '',
      containsSecret: false,
    });

    expect(resolveParamExpression(boolParam, {})).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });
    expect(resolveParamExpression(boolParam, { BOOL_P: 'FALSE' })).toEqual({
      ok: true,
      value: false,
      containsSecret: false,
    });
    expect(resolveParamExpression(boolParam, { BOOL_P: 'not-a-bool' })).toEqual({
      ok: false,
      reason: 'invalid',
      paramName: 'BOOL_P',
    });

    expect(resolveParamExpression(intParam, {})).toEqual({
      ok: true,
      value: 42,
      containsSecret: false,
    });
    expect(resolveParamExpression(intParam, { INT_P: ' 180 ' })).toEqual({
      ok: true,
      value: 180,
      containsSecret: false,
    });
    expect(resolveParamExpression(intParam, { INT_P: '3.14' })).toEqual({
      ok: false,
      reason: 'invalid',
      paramName: 'INT_P',
    });

    expect(resolveParamExpression(floatParam, { FLOAT_P: '1.25' })).toEqual({
      ok: true,
      value: 1.25,
      containsSecret: false,
    });
    expect(resolveParamExpression(floatParam, { FLOAT_P: 'Infinity' })).toEqual({
      ok: false,
      reason: 'invalid',
      paramName: 'FLOAT_P',
    });

    expect(resolveParamExpression(listParam, {})).toEqual({
      ok: true,
      value: ['us-central1'],
      containsSecret: false,
    });
    expect(
      resolveParamExpression(listParam, { LIST_P: '["us-east1","europe-west1"]' }),
    ).toEqual({
      ok: true,
      value: ['us-east1', 'europe-west1'],
      containsSecret: false,
    });
    expect(
      resolveParamExpression(listParam, { LIST_P: 'asia-northeast1, us-west1' }),
    ).toEqual({
      ok: true,
      value: ['asia-northeast1', 'us-west1'],
      containsSecret: false,
    });
    expect(resolveParamExpression(listParam, { LIST_P: '[1, 2]' })).toEqual({
      ok: false,
      reason: 'invalid',
      paramName: 'LIST_P',
    });

    expect(resolveParamExpression(unsetStr, {})).toEqual({
      ok: false,
      reason: 'missing',
      paramName: 'UNSET_STR',
    });
  });

  test('resolves defineSecret and defineJsonSecret while marking containsSecret and never leaking parse errors', () => {
    const sec = params.defineSecret('SYNTH_SECRET');
    const jsonSec = params.defineJsonSecret<{ host: string; port: number }>('SYNTH_JSON');

    expect(isParamExpression(sec)).toBe(true);
    expect(isParamExpression(jsonSec)).toBe(true);

    expect(resolveParamExpression(sec, {})).toEqual({
      ok: false,
      reason: 'missing',
      paramName: 'SYNTH_SECRET',
    });
    expect(resolveParamExpression(sec, { SYNTH_SECRET: 'synth-secret-val' })).toEqual({
      ok: true,
      value: 'synth-secret-val',
      containsSecret: true,
    });

    expect(
      resolveParamExpression(jsonSec, { SYNTH_JSON: '{"host":"db.local","port":5432}' }),
    ).toEqual({
      ok: true,
      value: { host: 'db.local', port: 5432 },
      containsSecret: true,
    });

    const badJsonResult = resolveParamExpression(jsonSec, {
      SYNTH_JSON: '{broken_secret_token_999',
    });
    expect(badJsonResult).toEqual({
      ok: false,
      reason: 'invalid',
      paramName: 'SYNTH_JSON',
    });
    expect(JSON.stringify(badJsonResult)).not.toContain('broken_secret_token_999');
  });

  test('resolves built-in internal params, compare, ternary, interpolation, and transform expressions', () => {
    const env = {
      FIREBASE_CONFIG: JSON.stringify({
        projectId: 'demo-expr',
        databaseURL: 'https://demo-expr-default-rtdb.firebasedatabase.app',
        storageBucket: 'demo-expr.firebasestorage.app',
      }),
      STAGE: 'prod',
      CONCURRENCY: '25',
      REGIONS_LIST: '["us-east1","us-west1"]',
      TENANT: 'acme',
    };

    expect(resolveParamExpression(params.projectID, env)).toEqual({
      ok: true,
      value: 'demo-expr',
      containsSecret: false,
    });
    expect(resolveParamExpression(params.gcloudProject, { GCLOUD_PROJECT: 'fallback-p' })).toEqual({
      ok: true,
      value: 'fallback-p',
      containsSecret: false,
    });
    expect(resolveParamExpression(params.storageBucket, env)).toEqual({
      ok: true,
      value: 'demo-expr.firebasestorage.app',
      containsSecret: false,
    });
    expect(resolveParamExpression(params.databaseURL, env)).toEqual({
      ok: true,
      value: 'https://demo-expr-default-rtdb.firebasedatabase.app',
      containsSecret: false,
    });

    const stage = params.defineString('STAGE');
    const conc = params.defineInt('CONCURRENCY');
    const regions = params.defineList('REGIONS_LIST');
    const tenant = params.defineString('TENANT');
    const unsetFallback = params.defineString('UNSET_BRANCH_PARAM');

    expect(resolveParamExpression(stage.equals('prod'), env)).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });
    expect(resolveParamExpression(stage.notEquals('dev'), env)).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });
    expect(resolveParamExpression(conc.greaterThan(10), env)).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });
    expect(resolveParamExpression(conc.lessThanOrEqualTo(25), env)).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });
    expect(resolveParamExpression(regions.equals(['us-west1', 'us-east1']), env)).toEqual({
      ok: true,
      value: true,
      containsSecret: false,
    });

    // Short-circuiting ternary: untaken branch may reference an unset param without failing.
    const chosenRegion = stage.equals('prod').thenElse('europe-west1', unsetFallback);
    expect(resolveParamExpression(chosenRegion, env)).toEqual({
      ok: true,
      value: 'europe-west1',
      containsSecret: false,
    });

    // DAG reuse of the same param inside expr template literal must succeed (not treated as a cycle).
    const docPath = params.expr`tenants/${tenant}/mirrors/${tenant}/{docId}`;
    expect(resolveParamExpression(docPath, env)).toEqual({
      ok: true,
      value: 'tenants/acme/mirrors/acme/{docId}',
      containsSecret: false,
    });

    const suffixed = paramsTypes.transform(tenant, (value) => `${value}-suffix`);
    expect(resolveParamExpression(suffixed, env)).toEqual({
      ok: true,
      value: 'acme-suffix',
      containsSecret: false,
    });
  });

  test('detects circular, overly deep, throwing, and non-Expression objects safely', () => {
    expect(isParamExpression({ expression: 'DOC_PATH' })).toBe(false);
    expect(isParamExpression({ cel: '{{ params.ATTEMPTS }}' })).toBe(false);
    expect(isParamExpression(optionsV2.RESET_VALUE)).toBe(false);

    // Self-referential default
    const selfDefault = params.defineString('SELF_DEF');
    (selfDefault.options as Record<string, unknown>).default = selfDefault;
    expect(resolveParamExpression(selfDefault, {})).toEqual({
      ok: false,
      reason: 'circular',
    });

    // Mutual default cycle: A -> B -> A
    const cycleA = params.defineString('CYCLE_A');
    const cycleB = params.defineString('CYCLE_B', { default: cycleA });
    (cycleA.options as Record<string, unknown>).default = cycleB;
    expect(resolveParamExpression(cycleA, {})).toEqual({
      ok: false,
      reason: 'circular',
    });

    // Self-referential ternary
    const flag = params.defineBoolean('FLAG_CIRC', { default: true });
    const circTernary = flag.thenElse('ok', 'no');
    (circTernary as unknown as Record<string, unknown>).ifTrue = circTernary;
    expect(resolveParamExpression(circTernary, {})).toEqual({
      ok: false,
      reason: 'circular',
    });

    // Deep chain exceeding max depth
    let deep = params.defineString('DEEP_0', { default: 'leaf' });
    for (let idx = 1; idx <= 70; idx += 1) {
      deep = params.defineString(`DEEP_${idx}`, { default: deep });
    }
    expect(resolveParamExpression(deep, {})).toEqual({
      ok: false,
      reason: 'circular',
    });

    // Throwing transformer
    const badTransform = paramsTypes.transform(params.defineString('T_SRC', { default: 'x' }), () => {
      throw new Error('boom');
    });
    expect(resolveParamExpression(badTransform, {})).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
