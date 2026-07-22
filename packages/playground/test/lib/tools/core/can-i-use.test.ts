import { describe, expect, test } from 'bun:test';
import { canIUseHandler } from '../../../../src/lib/tools/core/can-i-use';

describe('Playground can-i-use tool', () => {
  test('reads feature policy from the generated conformance query', async () => {
    const result = await canIUseHandler.execute({
      feature: 'linkWithCredential',
      importPath: 'pyric/auth',
    }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        feature: 'linkWithCredential',
        availability: 'available',
      })],
    });
  });

  test('queries rules constructs by surface-qualified identity without package scoping', async () => {
    const result = await canIUseHandler.execute({
      feature: 'firestore-rules/getAfter',
    }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        feature: 'getAfter',
        surface: 'firestore-rules',
        availability: 'available',
        fidelity: 'conforms',
        assurance: 'eligible',
      })],
    });

    for (const feature of ['rtdb-rules/auth.uid', 'storage-rules/rule-kind.allow-list']) {
      const sibling = await canIUseHandler.execute({ feature }, {} as never);
      expect(sibling.ok).toBe(true);
      expect(sibling.data).toMatchObject({
        match: 'exact',
        supports: [expect.objectContaining({ availability: 'available' })],
      });
    }
  });

  test('queries SDK member behavior by surface instead of pretending it is an export', async () => {
    const result = await canIUseHandler.execute({ feature: 'auth/providerData' }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        feature: 'providerData',
        surface: 'auth',
        availability: 'available',
      })],
    });
  });

  test('returns ambiguous candidates without signaling a usable trust answer', async () => {
    const result = await canIUseHandler.execute({ feature: 'get' }, {} as never);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ match: 'ambiguous' });
  });
});
