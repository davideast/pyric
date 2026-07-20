import { describe, expect, it } from 'bun:test';
import { createViteWorkerRuntime } from '../../src/serve/vite-worker-runtime.js';

describe('Vite worker runtime', () => {
  it('forces the in-page runtime until a worker bundle is ready', () => {
    const runtime = createViteWorkerRuntime({ cacheRoot: '/cache', cacheKey: 'key' });

    expect(runtime.status()).toEqual({ sdkDir: '/cache/key', ready: false, epoch: null });
    expect(runtime.headTag('data-pyric-sandbox')).toContain('__PYRIC_FORCE_INPAGE__');
  });

  it('atomically projects the epoch returned by a successful bundle', async () => {
    const calls: string[] = [];
    const runtime = createViteWorkerRuntime({
      cacheRoot: '/cache',
      cacheKey: 'key',
      bundle: async ({ outDir }) => {
        calls.push(outDir);
        return { outFile: `${outDir}/worker.js`, epoch: '0123456789abcdef' };
      },
    });

    await runtime.prepare();

    expect(calls).toEqual(['/cache/key']);
    expect(runtime.status()).toEqual({
      sdkDir: '/cache/key', ready: true, epoch: '0123456789abcdef',
    });
    expect(runtime.headTag('data-pyric-sandbox')).toBe(
      '<meta name="pyric-worker-v" content="0123456789abcdef" data-pyric-sandbox>',
    );
  });

  it('remains on the in-page fallback when bundling fails', async () => {
    const runtime = createViteWorkerRuntime({
      cacheRoot: '/cache',
      cacheKey: 'key',
      bundle: async () => { throw new Error('bundle failed'); },
    });

    await expect(runtime.prepare()).rejects.toThrow('bundle failed');
    expect(runtime.status()).toEqual({ sdkDir: '/cache/key', ready: false, epoch: null });
    expect(runtime.headTag('data-pyric-sandbox')).toContain('__PYRIC_FORCE_INPAGE__');
  });
});
