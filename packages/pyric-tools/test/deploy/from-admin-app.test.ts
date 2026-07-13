import { describe, expect, it } from 'bun:test';
import type { App as AdminApp } from 'firebase-admin/app';

import { getDeploy } from '../../src/deploy/from-admin-app.js';

describe('getDeploy', () => {
  it('preserves the active deployment error prefix', () => {
    const app = { options: {} } as unknown as AdminApp;

    expect(() => getDeploy(app)).toThrow('getDeploy: firebase-admin App has no projectId');
  });
});
