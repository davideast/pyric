import { describe, expect, it } from 'bun:test';
import { createConformanceTools } from '../../src/conformance/tools.js';

describe('conformance MCP tools', () => {
  it('exposes the same auditable support result through MCP', async () => {
    const tool = createConformanceTools()[0]!;
    const response = await tool.execute({ feature: 'getDownloadURL', importPath: 'pyric/storage' });
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      match: 'exact',
      supports: [{
        feature: 'getDownloadURL',
        surface: 'storage',
        availability: 'available',
        fidelity: 'diverged',
        assurance: 'qualified',
        evidenceSlug: 'pyric-storage-compat',
      }],
    });
  });

  it('does not attach a feature to an unrelated published import', async () => {
    const tool = createConformanceTools()[0]!;
    const response = await tool.execute({ feature: 'getDownloadURL', importPath: 'pyric/firestore' });
    expect(response.ok).toBe(false);
    expect(response.data).toMatchObject({ match: 'none', supports: [] });
  });

  it('returns ambiguous candidates for qualification without signaling success', async () => {
    const tool = createConformanceTools()[0]!;
    const response = await tool.execute({ feature: 'get' });
    expect(response.ok).toBe(false);
    expect(response.data).toMatchObject({ match: 'ambiguous' });
  });
});
