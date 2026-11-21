import { afterEach, describe, expect, test } from 'bun:test';
import { initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from '../../../pyric/dist/app/registry.js';
import { replayRecaptchaProvidersConstructMode } from '../../../pyric/test/app-check/client-provider-replays.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import {
  observeRecaptchaProvidersConstruct,
  probe as recaptchaProvidersConstructProbe,
} from '../../probes/app-check/app-check-recaptcha-providers-construct.ts';

const PROBE_ID = 'app-check-recaptcha-providers-construct';
const ROW_ID = 'app-check#recaptcha-providers-construct';

type DocumentGlobal = { document?: unknown };

describe('app-check#recaptcha-providers-construct linked sdk-probes capture', () => {
  afterEach(async () => {
    await resetAppRegistryForTests();
  });

  test('is registered as a linked sdk-probes target backed by a committed observation', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    expect(loaded.map((entry) => entry.id)).toContain(PROBE_ID);

    expect(recaptchaProvidersConstructProbe.rig).toBe('sdk-probes');
    expect(recaptchaProvidersConstructProbe.requires).toEqual(['web-config']);
    expect(recaptchaProvidersConstructProbe.pendingRowLink).toBeUndefined();
    expect(recaptchaProvidersConstructProbe.matrixRow).toBe(ROW_ID);
    expect(recaptchaProvidersConstructProbe.rowIds).toEqual([ROW_ID]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(
      previewLines.some(
        (line) =>
          line.includes(PROBE_ID) &&
          line.includes('observations/app-check/app-check-recaptcha-providers-construct.json') &&
          !line.includes('[pendingRowLink]'),
      ),
    ).toBe(true);

    const committed = loadObservations().find((entry) => entry.name === PROBE_ID);
    expect(committed).toBeDefined();
    expect(committed?.matrixRow).toBe(ROW_ID);
    expect(committed?.rowIds).toEqual([ROW_ID]);
    expect(committed?.fbSdkVersion).toBe('12.19.0');
  });

  test('pyric/app-check matches upstream firebase/app-check ReCaptcha provider construction and initializeAppCheck contract in a document realm', async () => {
    const observed = await observeRecaptchaProvidersConstruct();
    const committed = loadObservations().find((entry) => entry.name === PROBE_ID);
    expect(committed?.behavior).toEqual(observed as unknown as Record<string, unknown>);
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
