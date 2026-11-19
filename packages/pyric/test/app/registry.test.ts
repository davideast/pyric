import { afterEach, describe, expect, it } from 'bun:test';
import { initializeApp } from '../../src/app/index.js';
import {
  bindAppRegistryRefusal,
  bindAppRegistrySandbox,
  resetAppRegistryForTests,
} from '../../src/app/registry.js';
import { resolveClientApp } from '../../src/sandbox/internal/client-app.js';
import { initializeSandbox } from '../../src/sandbox/index.js';

const OPTIONS = { projectId: 'registry-bind-test' };

afterEach(async () => {
  await resetAppRegistryForTests();
});

describe('bindAppRegistrySandbox lifecycle', () => {
  it('allows idempotent re-binding to the same sandbox across named apps', () => {
    const shared = initializeSandbox();
    try {
      bindAppRegistrySandbox(shared);
      const first = initializeApp(OPTIONS, 'first');
      bindAppRegistrySandbox(shared);
      const second = initializeApp(OPTIONS, 'second');

      expect(resolveClientApp(first)?.sandbox).toBe(shared);
      expect(resolveClientApp(second)?.sandbox).toBe(shared);
    } finally {
      shared.dispose();
    }
  });

  it('throws when the registry is already bound to another sandbox or refusal', async () => {
    const firstSandbox = initializeSandbox();
    const secondSandbox = initializeSandbox();
    try {
      initializeApp(OPTIONS, 'default-owned');
      expect(() => bindAppRegistrySandbox(firstSandbox)).toThrow(
        'pyric/app/internal: the app registry sandbox is already bound',
      );

      await resetAppRegistryForTests();
      bindAppRegistrySandbox(firstSandbox);
      expect(() => bindAppRegistrySandbox(secondSandbox)).toThrow(
        'pyric/app/internal: the app registry sandbox is already bound',
      );

      await resetAppRegistryForTests();
      bindAppRegistryRefusal(() => new Error('refused'));
      expect(() => bindAppRegistrySandbox(firstSandbox)).toThrow(
        'pyric/app/internal: the app registry sandbox is already bound',
      );
    } finally {
      firstSandbox.dispose();
      secondSandbox.dispose();
    }
  });

  it('does not dispose a caller-owned sandbox during resetAppRegistryForTests', async () => {
    const shared = initializeSandbox();
    let seenEvents = 0;
    const unsubscribe = shared.onEvent(() => {
      seenEvents += 1;
    });
    try {
      bindAppRegistrySandbox(shared);
      initializeApp(OPTIONS, 'before-reset');
      await resetAppRegistryForTests();

      bindAppRegistrySandbox(shared);
      initializeApp(OPTIONS, 'after-reset');
      seenEvents = 0;
      shared.reset();
      expect(seenEvents).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      shared.dispose();
    }
  });
});
