import { describe, expect, it } from 'bun:test';
import { createViteWorkerRuntime } from '../../src/serve/vite-worker-runtime.js';

describe('Vite worker runtime', () => {
  it('forces the in-page runtime until a worker bundle is ready', () => {
    const runtime = createViteWorkerRuntime({ cacheRoot: '/cache', cacheKey: 'key' });

    expect(runtime.status()).toEqual({ sdkDir: '/cache/key', ready: false, epoch: null });
    expect(runtime.headTag('data-pyric-sandbox')).toContain('__PYRIC_FORCE_INPAGE__');
  });

  it('atomically projects the epoch returned by a successful bundle', async () => {
    const calls: Array<{ outDir: string; epochSalt?: string }> = [];
    const runtime = createViteWorkerRuntime({
      cacheRoot: '/cache',
      cacheKey: 'key',
      bundle: async ({ outDir, epochSalt }) => {
        calls.push({ outDir, epochSalt });
        return { outFile: `${outDir}/worker.js`, epoch: '0123456789abcdef' };
      },
    });

    await runtime.prepare('project=/app;ai=openai:qwen3');

    expect(calls).toEqual([{
      outDir: expect.stringMatching(/^\/cache\/key-[a-f0-9]{12}$/),
      epochSalt: 'project=/app;ai=openai:qwen3',
    }]);
    expect(runtime.status()).toEqual({
      sdkDir: calls[0]!.outDir, ready: true, epoch: '0123456789abcdef',
    });
    expect(runtime.headTag('data-pyric-sandbox')).toBe(
      '<meta name="pyric-worker-v" content="0123456789abcdef" data-pyric-sandbox>',
    );
  });

  it('isolates worker artifacts when restart-required configuration changes', async () => {
    const calls: string[] = [];
    const runtime = createViteWorkerRuntime({
      cacheRoot: '/cache',
      cacheKey: 'key',
      bundle: async ({ outDir }) => {
        calls.push(outDir);
        return { outFile: `${outDir}/worker.js`, epoch: '0123456789abcdef' };
      },
    });

    await runtime.prepare('ai=scripted');
    await runtime.prepare('ai=openai:qwen3');

    expect(calls[0]).not.toBe(calls[1]);
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
