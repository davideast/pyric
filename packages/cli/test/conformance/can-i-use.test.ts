import { describe, expect, it } from 'bun:test';
import { canIUse, createConformanceTools, type FeatureSupport } from '../../src/conformance/index.js';

function one(query: string): FeatureSupport {
  const result = canIUse(query);
  if (Array.isArray(result)) throw new Error(`expected one result for ${query}`);
  return result;
}

describe('packaged conformance query', () => {
  it('preserves the three trust axes in the generated Node projection', () => {
    expect(one('getAfter')).toMatchObject({
      availability: 'available',
      fidelity: 'diverged',
      assurance: 'ineligible',
    });
    expect(one('onDisconnect')).toMatchObject({
      availability: 'deferred',
      fidelity: 'not-applicable',
      assurance: 'not-applicable',
    });
  });

  it('exposes the exact same result through MCP', async () => {
    const tool = createConformanceTools()[0]!;
    const response = await tool.execute({ feature: 'getDownloadURL' });
    expect(response.ok).toBe(true);
    expect(response.data).toEqual(canIUse('getDownloadURL'));
  });
});
