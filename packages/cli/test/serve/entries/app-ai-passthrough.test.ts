import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as sdkApp from 'firebase/app';
import * as pyricApp from 'pyric/app';
import {
  bindAppRegistryRefusal,
  bindAppRegistrySandbox,
  resetAppRegistryForTests,
} from 'pyric/app/internal';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { shadowAppOf } from '../../../src/register/app-bridge-shadow.js';
import { sandbox } from '../../../src/serve/entries/app-backend.js';

const OPTIONS = {
  apiKey: 'demo-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  projectId: 'served-ai-passthrough-entry-test',
};

beforeEach(async () => {
  await resetAppRegistryForTests();
});

afterEach(async () => {
  await Promise.all(sdkApp.getApps().map((app) => sdkApp.deleteApp(app)));
  await resetAppRegistryForTests();
});

describe('served app-ai-passthrough entry lazy registry binding (#1778)', () => {
  it('imports cleanly when an earlier suite left the shared registry bound', async () => {
    pyricApp.initializeApp({ projectId: 'other-suite-project' }, 'prior-app');

    const served = await import('../../../src/serve/entries/app-ai-passthrough.js');
    expect(typeof served.initializeApp).toBe('function');
    expect(() => served.initializeApp(OPTIONS, 'conflict-app')).toThrow(
      'pyric/app/internal: the app registry sandbox is already bound',
    );
  });

  it('binds the served sandbox and creates shadow Firebase apps on initializeApp after reset', async () => {
    bindAppRegistryRefusal(() => new Error('prior refusal'));
    const served = await import('../../../src/serve/entries/app-ai-passthrough.js');

    await resetAppRegistryForTests();
    const first = served.initializeApp(OPTIONS, 'passthrough-first');
    const second = served.initializeApp(OPTIONS, 'passthrough-second');

    expect(() => bindAppRegistrySandbox(sandbox)).not.toThrow();
    const otherSandbox = createSandboxRoot();
    try {
      expect(() => bindAppRegistrySandbox(otherSandbox)).toThrow(
        'pyric/app/internal: the app registry sandbox is already bound',
      );
    } finally {
      otherSandbox.dispose();
    }
    expect(shadowAppOf(first)).toBe(sdkApp.getApp('passthrough-first'));
    expect(shadowAppOf(second)).toBe(sdkApp.getApp('passthrough-second'));

    await served.deleteApp(first);
    await served.deleteApp(second);
  });
});
