import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  getApp,
  initializeApp,
} from './register.js';
import { resetAppRegistryForTests } from './registry.js';

beforeEach(() => resetAppRegistryForTests());

afterEach(() => resetAppRegistryForTests());

describe('Node register app adapter', () => {
  it('loads rules through the published sandbox control seams', () => {
    const adapter = readFileSync(new URL('./register.ts', import.meta.url), 'utf8');
    const rules = readFileSync(new URL('./register-rules.ts', import.meta.url), 'utf8');

    expect(adapter).toContain("from './register-rules.js'");
    expect(rules).toContain("from 'pyric/sandbox/firestore'");
    expect(rules).toContain("from 'pyric/sandbox/database'");
    for (const source of [adapter, rules]) {
      expect(source).not.toContain("from '../firestore/");
      expect(source).not.toContain("from '../database/");
      expect(source).not.toContain("from '../storage/");
    }
  });

  it('translates Firebase options into a sandbox app while preserving public config fields', () => {
    const options = { apiKey: 'ignored-in-sandbox', projectId: 'demo-project' };
    const app = initializeApp(options, 'node-register');

    expect(app.options).not.toBe(options);
    expect(app.options).toEqual(options);
    expect(app.automaticDataCollectionEnabled).toBe(true);
    expect(getApp('node-register')).toBe(app);
  });
});
