import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { callableOnCallFamily, inspectOnCall } from '../../src/functions/callable/discovery.js';
import { httpFunctionInfo, httpOnRequestFamily, inspectOnRequest } from '../../src/functions/http/discovery.js';
import { httpFunctionLines, servedLine } from '../../src/functions/http/report.js';
import { buildFunctionsChildEnv } from '../../src/functions/spawn.js';
import { rtdbCreatedFamily } from '../../src/functions/rtdb/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(join(import.meta.dir, '../../../conformance/package.json'));
const https = requireFromConformance('firebase-functions/v2/https') as typeof import('firebase-functions/v2/https');
const v2 = requireFromConformance('firebase-functions/v2') as typeof import('firebase-functions/v2');
const v1 = requireFromConformance('firebase-functions/v1') as typeof import('firebase-functions/v1');

describe('inspectOnCall', () => {
  test('reads region, timeout, and platform from v2 onCall and v1 https.onCall manifests', () => {
    const exported = {
      plain: https.onCall(() => 'ok'),
      regional: https.onCall({ region: ['europe-west1', 'us-east1'], timeoutSeconds: 15 }, () => 'ok'),
      grouped: { nested: https.onCall({ region: 'asia-northeast1' }, () => 'ok') },
      legacy: v1.https.onCall(() => 'ok'),
      legacyRegional: v1.region('europe-west3').https.onCall(() => 'ok'),
      httpOnly: https.onRequest((_req, res) => { res.end(); }),
    };

    expect(inspectOnCall(exported).map(httpFunctionInfo)).toEqual([
      { exportName: 'plain', kind: 'callable', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'regional', kind: 'callable', regions: ['europe-west1', 'us-east1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: 15 },
      { exportName: 'grouped-nested', kind: 'callable', regions: ['asia-northeast1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'legacy', kind: 'callable', regions: ['us-central1'], platform: 'gcfv1', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'legacyRegional', kind: 'callable', regions: ['europe-west3'], platform: 'gcfv1', privateInvoker: false, timeoutSeconds: null },
    ]);
    expect(inspectOnRequest({ plain: exported.plain, legacy: exported.legacy })).toEqual([]);
  });

  test('claims onCall and onCallGenkit exports and reports omitted exports as unsupported', () => {
    const fakeAction = Object.assign(() => undefined, {
      __action: { name: 'summarizeItems' },
      run: async () => ({ result: 'ok' }),
      stream: () => ({ stream: (async function* empty() {})(), output: Promise.resolve('ok') }),
    });
    const exported = {
      active: https.onCall(() => 'ok'),
      omitted: https.onCall({ omit: true }, () => 'skip'),
      genkit: https.onCallGenkit(fakeAction as never),
      genkitOmitted: https.onCallGenkit({ omit: true }, fakeAction as never),
    };

    expect(inspectOnCall(exported).map((fn) => fn.exportName)).toEqual(['active', 'genkit']);
    expect(
      findUnsupportedTriggers(exported, [rtdbCreatedFamily, httpOnRequestFamily, callableOnCallFamily]),
    ).toEqual([
      { exportName: 'omitted', eventType: 'callable (omitted from emulation)' },
      { exportName: 'genkitOmitted', eventType: 'callable (omitted from emulation)' },
    ]);
  });

  test('formats onCall startup URLs and execution lines alongside onRequest functions', () => {
    const functions = [
      ...inspectOnRequest({ api: https.onRequest((_req, res) => { res.end(); }) }).map(httpFunctionInfo),
      ...inspectOnCall({ echo: https.onCall(() => 'ok') }).map(httpFunctionInfo),
    ];
    expect(httpFunctionLines({ port: 9000, token: 'tok', functions }, 'http://127.0.0.1:5174', 'demo-proj')).toEqual([
      'functions 1 onRequest function:',
      '    http://127.0.0.1:5174/demo-proj/us-central1/api',
      'functions 1 onCall function:',
      '    http://127.0.0.1:5174/demo-proj/us-central1/echo',
    ]);

    expect(
      servedLine({
        exportName: 'echo',
        kind: 'callable',
        method: 'POST',
        path: '/',
        status: 200,
        timedOut: false,
        durationMs: 7,
      }),
    ).toEqual({
      failed: false,
      line: 'function  echo <- callable 200 (7 ms)',
    });
  });

  test('strips FIREBASE_DEBUG_MODE and FIREBASE_DEBUG_FEATURES from child env', () => {
    const env = buildFunctionsChildEnv({
      baseEnv: {
        FIREBASE_DEBUG_MODE: 'true',
        FIREBASE_DEBUG_FEATURES: '{"skipTokenVerification":true}',
        GOOGLE_APPLICATION_CREDENTIALS: '/path/to/creds.json',
      },
      entry: '/work/functions/index.js',
      instance: 'demo-proj-default-rtdb',
      location: 'us-central1',
      databaseHost: 'firebasedatabase.app',
      projectId: 'demo-proj',
    });
    expect(env.FIREBASE_DEBUG_MODE).toBeUndefined();
    expect(env.FIREBASE_DEBUG_FEATURES).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  test('takes the region from setGlobalOptions when the options name none', () => {
    v2.setGlobalOptions({ region: 'europe-west2' });
    try {
      const exported = {
        global: https.onCall(() => 'ok'),
        own: https.onCall({ region: 'us-west1' }, () => 'ok'),
      };
      expect(inspectOnCall(exported).map((fn) => [fn.exportName, fn.regions])).toEqual([
        ['global', ['europe-west2']],
        ['own', ['us-west1']],
      ]);
    } finally {
      v2.setGlobalOptions({});
    }
  });
});
