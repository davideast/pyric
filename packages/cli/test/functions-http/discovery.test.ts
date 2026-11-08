import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { httpFunctionInfo, inspectOnRequest } from '../../src/functions/http/discovery.js';
import { createPrivateInvokerWarnings } from '../../src/functions/http/report.js';
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

  // firebase-tools binds an invoker list as IAM members, and adds allUsers only for 'public'.
  test('a function is public only with no invoker, or an invoker list that names public', () => {
    const exported = {
      open: https.onRequest(handler),
      declaredPublic: https.onRequest({ invoker: 'public' }, handler),
      locked: https.onRequest({ invoker: 'private' }, handler),
      backend: https.onRequest({ invoker: 'backend@' }, handler),
      accounts: https.onRequest({ invoker: ['backend@demo.iam.gserviceaccount.com', 'jobs@demo.iam.gserviceaccount.com'] }, handler),
      legacyAccounts: v1.runWith({ invoker: ['backend@demo.iam.gserviceaccount.com'] }).https.onRequest(handler),
      legacyPublic: v1.runWith({ invoker: 'public' }).https.onRequest(handler),
    };
    expect(inspectOnRequest(exported).map((fn) => [fn.exportName, fn.privateInvoker])).toEqual([
      ['open', false],
      ['declaredPublic', false],
      ['locked', true],
      ['backend', true],
      ['accounts', true],
      ['legacyAccounts', true],
      ['legacyPublic', false],
    ]);
  });

  test('the startup warning names a function only service accounts may invoke', () => {
    const exported = {
      open: https.onRequest(handler),
      backend: https.onRequest({ invoker: 'backend@' }, handler),
    };
    const functions = inspectOnRequest(exported).map(httpFunctionInfo);
    const lines = createPrivateInvokerWarnings()({ port: 0, token: 't', functions });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('functions export backend sets an invoker other than \'public\'');
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

  test('skips onRequest exports with omit: true and reports them as omitted', () => {
    const exported = {
      active: https.onRequest(handler),
      omitted: https.onRequest({ omit: true }, handler),
    };
    expect(inspectOnRequest(exported).map((fn) => fn.exportName)).toEqual(['active']);
    expect(findUnsupportedTriggers(exported, [httpOnRequestFamily])).toEqual([
      { exportName: 'omitted', eventType: 'https (omitted from emulation)' },
    ]);
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
