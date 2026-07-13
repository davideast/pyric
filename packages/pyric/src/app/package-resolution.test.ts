import { describe, expect, it } from 'bun:test';

import { initializeApp } from './index.js';

describe('pyric/app package resolution boundary', () => {
  it('rejects production Firebase config instead of dispatching to firebase/app', () => {
    expect(() =>
      initializeApp(
        { apiKey: 'production-api-key', projectId: 'production-project' } as never,
        'production-config-must-not-load',
      ),
    ).toThrow(
      'pyric/app: production selection happens by importing firebase/app; ' +
        'the pyric/app mirror accepts { sandbox } only.',
    );
  });
});
