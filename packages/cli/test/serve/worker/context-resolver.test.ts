import { describe, expect, it } from 'bun:test';
import { createContextResolver } from '../../../src/serve/worker/context-resolver.js';

describe('context-resolver', () => {
  it('resolves successfully and memoizes the resolved context', async () => {
    let factoryCalls = 0;
    const resolver = createContextResolver(async () => {
      factoryCalls++;
      return { id: 'ctx-1' };
    });

    expect(resolver.current()).toBeNull();

    const first = await resolver.get();
    expect(first).toEqual({ id: 'ctx-1' });
    expect(factoryCalls).toBe(1);
    expect(resolver.current()).toBe(first);

    const second = await resolver.get();
    expect(second).toBe(first);
    expect(factoryCalls).toBe(1);
  });

  it('coalesces concurrent in-flight calls to a single factory invocation', async () => {
    let factoryCalls = 0;
    let finish: ((val: { id: string }) => void) | null = null;

    const resolver = createContextResolver(() => {
      factoryCalls++;
      return new Promise<{ id: string }>((resolve) => {
        finish = resolve;
      });
    });

    const promise1 = resolver.get();
    const promise2 = resolver.get();
    const promise3 = resolver.get();

    expect(factoryCalls).toBe(1);
    finish!({ id: 'concurrent-ctx' });

    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);
    expect(r1).toEqual({ id: 'concurrent-ctx' });
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(factoryCalls).toBe(1);
  });

  it('does not permanently poison on rejection; subsequent call retries factory', async () => {
    let attempts = 0;
    const resolver = createContextResolver(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('transient IDB or network failure');
      }
      return { id: `recovered-ctx-${attempts}` };
    });

    // First attempt rejects
    await expect(resolver.get()).rejects.toThrow('transient IDB or network failure');
    expect(attempts).toBe(1);
    expect(resolver.current()).toBeNull();

    // Second attempt retries factory and succeeds instead of rethrowing cached rejection
    const recovered = await resolver.get();
    expect(recovered).toEqual({ id: 'recovered-ctx-2' });
    expect(attempts).toBe(2);
    expect(resolver.current()).toBe(recovered);

    // Third call reuses successfully resolved instance
    const cached = await resolver.get();
    expect(cached).toBe(recovered);
    expect(attempts).toBe(2);
  });

  it('resets memoized state on reset()', async () => {
    let counter = 0;
    const resolver = createContextResolver(async () => {
      counter++;
      return { count: counter };
    });

    const first = await resolver.get();
    expect(first.count).toBe(1);

    resolver.reset();
    expect(resolver.current()).toBeNull();

    const second = await resolver.get();
    expect(second.count).toBe(2);
  });
});
