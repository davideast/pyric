import { afterEach, describe, expect, test } from 'bun:test';
import { initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from '../../../pyric/dist/app/registry.js';
import { replayRecaptchaProvidersConstructMode } from '../../../pyric/test/app-check/client-provider-replays.ts';
import {
  observeRecaptchaProvidersConstruct,
  probe as recaptchaProvidersConstructProbe,
} from '../../probes/app-check/app-check-recaptcha-providers-construct.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

type DocumentGlobal = { document?: unknown };

describe('app-check-recaptcha-providers-construct staged probe', () => {
  afterEach(async () => {
    await resetAppRegistryForTests();
  });

  test('is registered as a pendingRowLink sdk-probes target until captured and linked', () => {
    expect(recaptchaProvidersConstructProbe.rig).toBe('sdk-probes');
    expectStagedUntilCaptured('app-check-recaptcha-providers-construct', {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });
  });

  test('pyric/app-check matches upstream firebase/app-check ReCaptcha provider construction and initializeAppCheck contract in a document realm', async () => {
    const observed = await observeRecaptchaProvidersConstruct();
    expect(observed.hasStandInDocument).toBe(true);
    expect(observed.domSideEffects.recaptchaV3).toEqual({
      appendedHiddenDivForApp: true,
      appendedRecaptchaScriptSrc: 'https://www.google.com/recaptcha/api.js',
    });
    expect(observed.domSideEffects.recaptchaEnterprise).toEqual({
      appendedHiddenDivForApp: true,
      appendedRecaptchaScriptSrc: 'https://www.google.com/recaptcha/enterprise.js?render=explicit',
    });

    const docGlobal = globalThis as DocumentGlobal;
    const hadDocument = Object.prototype.hasOwnProperty.call(docGlobal, 'document');
    const previousDocument = docGlobal.document;
    let seq = 0;
    docGlobal.document = {};
    try {
      const actual = replayRecaptchaProvidersConstructMode((label) => {
        seq += 1;
        return initializeApp(
          {
            apiKey: 'demo-api-key',
            appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
            projectId: 'demo-project',
          },
          `${label}-${seq}`,
        );
      });
      expect(actual).toEqual(observed.providerContract);
    } finally {
      if (hadDocument) {
        docGlobal.document = previousDocument;
      } else {
        delete docGlobal.document;
      }
    }
  });
});
