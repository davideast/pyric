import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from './register.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Node register app adapter', () => {
  it('depends on Firestore through its published sandbox control seam', () => {
    const source = readFileSync(new URL('./register.ts', import.meta.url), 'utf8');

    expect(source).toContain("from 'pyric/sandbox/firestore'");
    expect(source).not.toContain("from '../firestore/");
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
