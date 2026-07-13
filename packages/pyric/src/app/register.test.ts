import { afterEach, describe, expect, it } from 'bun:test';

import {
  APP_TARGET,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from './register.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Node register app adapter', () => {
  it('translates Firebase options into a sandbox app while preserving public config fields', () => {
    const options = { apiKey: 'ignored-in-sandbox', projectId: 'demo-project' };
    const app = initializeApp(options, 'node-register');

    expect(app[APP_TARGET]).toBe('sandbox');
    expect(app.options).toBe(options);
    expect(app.automaticDataCollectionEnabled).toBe(true);
    expect(getApp('node-register')).toBe(app);
  });
});
