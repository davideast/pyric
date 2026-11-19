import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as pyricApp from 'pyric/app';
import {
  bindAppRegistryRefusal,
  bindAppRegistrySandbox,
  resetAppRegistryForTests,
} from 'pyric/app/internal';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { sandbox } from '../../../src/serve/entries/app-backend.js';

const OPTIONS = { projectId: 'served-app-entry-test' };

beforeEach(async () => {
  await resetAppRegistryForTests();
});

afterEach(async () => {
  await resetAppRegistryForTests();
});

describe('served firebase/app entry lazy registry binding (#1778)', () => {
  it('imports cleanly when another suite already bound the shared registry', async () => {
    pyricApp.initializeApp({ projectId: 'other-suite-project' }, 'prior-app');

    const served = await import('../../../src/serve/entries/app.js');
    expect(typeof served.initializeApp).toBe('function');
    expect(() => served.initializeApp(OPTIONS, 'conflict-app')).toThrow(
      'pyric/app/internal: the app registry sandbox is already bound',
    );
  });

  it('binds the served app-backend sandbox on initializeApp across resets and named apps', async () => {
    bindAppRegistryRefusal(() => new Error('prior refusal'));
    const served = await import('../../../src/serve/entries/app.js');

    await resetAppRegistryForTests();
    const first = served.initializeApp(OPTIONS, 'served-first');
    const second = served.initializeApp(OPTIONS, 'served-second');
    expect(first.name).toBe('served-first');
    expect(second.name).toBe('served-second');
    expect(() => bindAppRegistrySandbox(sandbox)).not.toThrow();

    const otherSandbox = createSandboxRoot();
    try {
      expect(() => bindAppRegistrySandbox(otherSandbox)).toThrow(
        'pyric/app/internal: the app registry sandbox is already bound',
      );
    } finally {
      otherSandbox.dispose();
    }
  });
});
