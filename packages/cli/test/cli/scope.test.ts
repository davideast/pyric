import { describe, expect, it, mock } from 'bun:test';

import { resolveScope } from '../../src/cli/scope.js';

describe('hosted verification credentials', () => {
  it('prefers an existing Firebase CLI login before ADC', async () => {
    const adc = mock(async () => null);
    const result = await resolveScope({
      projectId: 'demo-project',
      env: {},
      firebaseCli: async (projectId) => ({
        projectId,
        resolveToken: async () => 'firebase-token',
      }),
      adc,
    });

    expect(result.source).toBe('firebase-cli');
    expect(await result.scope.resolveToken()).toBe('firebase-token');
    expect(adc).not.toHaveBeenCalled();
  });

  it('falls through to ADC when Firebase CLI has no usable login', async () => {
    const result = await resolveScope({
      projectId: 'demo-project',
      env: {},
      firebaseCli: async () => null,
      adc: async (projectId) => ({
        projectId,
        resolveToken: async () => 'adc-token',
      }),
    });

    expect(result.source).toBe('adc');
    expect(await result.scope.resolveToken()).toBe('adc-token');
  });
});
