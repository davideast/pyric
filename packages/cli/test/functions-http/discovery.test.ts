import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { httpFunctionInfo, inspectOnRequest } from '../../src/functions/http/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';
import { rtdbCreatedFamily } from '../../src/functions/rtdb/discovery.js';
import { httpOnRequestFamily } from '../../src/functions/http/discovery.js';

const requireFromConformance = createRequire(join(import.meta.dir, '../../../conformance/package.json'));
const https = requireFromConformance('firebase-functions/v2/https') as typeof import('firebase-functions/v2/https');
const v2 = requireFromConformance('firebase-functions/v2') as typeof import('firebase-functions/v2');
const v1 = requireFromConformance('firebase-functions/v1') as typeof import('firebase-functions/v1');

const handler = (_req: unknown, res: { end(): void }): void => res.end();

describe('inspectOnRequest', () => {
  test('reads region, invoker, timeout, and platform from v2 onRequest manifests', () => {
    const exported = {
      plain: https.onRequest(handler),
      regional: https.onRequest({ region: ['europe-west1', 'us-east1'] }, handler),
      locked: https.onRequest({ invoker: 'private', timeoutSeconds: 5 }, handler),
      grouped: { nested: https.onRequest({ region: 'asia-northeast1' }, handler) },
      helper: () => undefined,
    };
    expect(inspectOnRequest(exported).map(httpFunctionInfo)).toEqual([
      { exportName: 'plain', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'regional', regions: ['europe-west1', 'us-east1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'locked', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: true, timeoutSeconds: 5 },
      { exportName: 'grouped-nested', regions: ['asia-northeast1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null },
    ]);
  });

  test('serves v1 https.onRequest with the default region and with functions.region(r)', () => {
    const exported = {
      legacy: v1.https.onRequest(handler),
      legacyRegional: v1.region('europe-west3').https.onRequest(handler),
    };
    expect(inspectOnRequest(exported).map(httpFunctionInfo)).toEqual([
      { exportName: 'legacy', regions: ['us-central1'], platform: 'gcfv1', privateInvoker: false, timeoutSeconds: null },
      { exportName: 'legacyRegional', regions: ['europe-west3'], platform: 'gcfv1', privateInvoker: false, timeoutSeconds: null },
    ]);
  });

  test('onCall endpoints are not onRequest functions', () => {
    const exported = { callable: https.onCall(() => 'ok') };
    expect(inspectOnRequest(exported)).toEqual([]);
    expect(findUnsupportedTriggers(exported, [rtdbCreatedFamily, httpOnRequestFamily])).toEqual([
      { exportName: 'callable', eventType: 'callable' },
    ]);
  });

  test('the HTTP family claims onRequest exports, so they are no longer reported unsupported', () => {
    const exported = { api: https.onRequest(handler), legacy: v1.https.onRequest(handler) };
    expect(findUnsupportedTriggers(exported, [rtdbCreatedFamily])).toEqual([
      { exportName: 'api', eventType: 'https' },
      { exportName: 'legacy', eventType: 'https' },
    ]);
    expect(findUnsupportedTriggers(exported, [rtdbCreatedFamily, httpOnRequestFamily])).toEqual([]);
  });

  // Last: setGlobalOptions is process-wide state in firebase-functions.
  test('takes the region from setGlobalOptions when the options name none', () => {
    v2.setGlobalOptions({ region: 'europe-west2' });
    try {
      const exported = { global: https.onRequest(handler), own: https.onRequest({ region: 'us-west1' }, handler) };
      expect(inspectOnRequest(exported).map((fn) => [fn.exportName, fn.regions])).toEqual([
        ['global', ['europe-west2']],
        ['own', ['us-west1']],
      ]);
    } finally {
      // Other files in this bun process read endpoint manifests through the same module.
      v2.setGlobalOptions({});
    }
  });
});
