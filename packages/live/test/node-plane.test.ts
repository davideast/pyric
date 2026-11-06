/**
 * The Node plane's parts that run without a Node host: the modules the
 * register serves for the live rows, and the refusal a Node process gets.
 * `packages/cli/test/e2e/live-node-plane.pw.ts` drives them through a real
 * Node process and host.
 */
import { describe, expect, test } from 'bun:test';
import { REGISTER_OBSERVER_URL, REGISTER_ROW_URLS } from '@pyric/cli/register/internal/supplied-rows';
import { LIVE_ROWS, replacedExports } from '../src/index.js';
import { liveRefusal as installedRefusal, liveRegisterModuleSource, serveHostProject } from '../src/node-modules.js';
import { LIVE_REFUSED, liveRefusal } from '../src/refusal.js';

const SENDER = 'file:///cli/dist/register/observed-call-sender.js';

describe('the modules a Node process gets for the live rows', () => {
  test("import the installed module, re-export all of it, and export each observed name from the row's wrapper", () => {
    for (const [specifier, key] of LIVE_ROWS) {
      const url = REGISTER_ROW_URLS.get(specifier);
      expect(url, specifier).toBeDefined();
      const source = liveRegisterModuleSource(url ?? '', SENDER) as string;
      const quoted = JSON.stringify(specifier);
      expect(source).toContain(`import * as __pyricReal from ${quoted};`);
      expect(source).toContain(`export * from ${quoted};`);
      expect(source).toContain(`import { observer } from ${JSON.stringify(REGISTER_OBSERVER_URL)};`);
      expect(source).toMatch(/import \{ liveModuleFor \} from "file:\/\/\/.+\/rows\.js";/);
      for (const name of replacedExports(key)) {
        expect(source).toContain(`export const ${name} = __pyricLive.${name};`);
      }
    }
  });

  test('share one observer module that sends through the Node sender, and serve no other id', () => {
    const observer = liveRegisterModuleSource(REGISTER_OBSERVER_URL, SENDER) as string;
    expect(observer).toContain(`import { sendObservedCall } from ${JSON.stringify(SENDER)};`);
    expect(observer).toContain('pageObserver(sendObservedCall)');
    const functionsId = (REGISTER_ROW_URLS.get('firebase/firestore') ?? '').replace('firebase/firestore', 'firebase/functions');
    expect(liveRegisterModuleSource(functionsId, SENDER)).toBeNull();
    expect(liveRegisterModuleSource('firebase/firestore', SENDER)).toBeNull();
  });
});

describe('the observer a Node process gets', () => {
  test('carries the project the register resolved and the Node client', () => {
    serveHostProject('live-a');
    const observer = liveRegisterModuleSource(REGISTER_OBSERVER_URL, SENDER) as string;
    expect(observer).toContain('export const observer = Object.assign(pageObserver(sendObservedCall), { hostProjectId: "live-a", client: "node" });');
  });
});

describe('the refusal a Node process gets', () => {
  test('names live mode, the service and the Node process', () => {
    const error = liveRefusal('firebase/functions', 'node') as Error & { code?: string };
    expect(error.code).toBe(LIVE_REFUSED);
    expect(error.message).toContain('firebase/functions (Cloud Functions) is refused in live mode');
    expect(error.message).toContain('to a Node process, from your installed Firebase SDK');
    expect(liveRefusal('firebase-admin', 'node').message).toContain('firebase-admin (the Admin SDK) is refused in live mode');
    // The register loads the refusal from this package's node-modules export, never from its caller.
    expect(installedRefusal).toBe(liveRefusal);
  });
});
