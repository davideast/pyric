import { afterEach, describe, expect, it } from 'bun:test';
import * as upstream from 'firebase/app';
import { initializeApp, getApps, deleteApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-duplicate-app', appId: '1:0:web:0' };

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

/** The duplicate-app message the installed firebase/app produces for the same calls. */
function upstreamMessage(first: () => unknown, second: () => unknown): string {
  try {
    first();
    return messageOf(second);
  } finally {
    for (const app of upstream.getApps()) void upstream.deleteApp(app);
  }
}

describe('app/duplicate-app message', () => {
  afterEach(async () => {
    for (const app of getApps()) await deleteApp(app);
    resetAppRegistryForTests();
  });

  it('names the mismatched config and both serialized values, as firebase/app does', () => {
    const settings = { name: 'dup-config', automaticDataCollectionEnabled: false };
    const expected = upstreamMessage(
      () => upstream.initializeApp(OPTS, 'dup-config'),
      () => upstream.initializeApp(OPTS, settings),
    );
    initializeApp(OPTS, 'dup-config');
    expect(messageOf(() => initializeApp(OPTS, settings))).toBe(expected);
  });

  it('names the mismatched options and both serialized values, as firebase/app does', () => {
    const changed = { ...OPTS, projectId: 'another-project' };
    const expected = upstreamMessage(
      () => upstream.initializeApp(OPTS, 'dup-options'),
      () => upstream.initializeApp(changed, 'dup-options'),
    );
    initializeApp(OPTS, 'dup-options');
    expect(messageOf(() => initializeApp(changed, 'dup-options'))).toBe(expected);
  });
});
