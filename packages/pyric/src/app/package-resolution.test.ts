import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initializeApp } from './index.js';
import { resetAppRegistryForTests } from './registry.js';

describe('pyric/app package resolution boundary', () => {
  beforeEach(() => resetAppRegistryForTests());
  afterEach(() => resetAppRegistryForTests());

  it('accepts Firebase config while package resolution keeps the backend local', () => {
    const app = initializeApp(
      { apiKey: 'ignored-in-sandbox', projectId: 'demo-project' },
      'firebase-shaped-config',
    );
    expect(app.name).toBe('firebase-shaped-config');
    expect(app.options.projectId).toBe('demo-project');
  });
});
