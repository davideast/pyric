import { describe, expect, it } from 'bun:test';
import { defaultSdkEntries } from '../../src/serve/bundler.js';
import { createVitePageRuntime } from '../../src/serve/vite-page-runtime.js';

function runtime(options: Parameters<typeof createVitePageRuntime>[0]['options'] = {}) {
  return createVitePageRuntime({
    options,
    studioEnabled: true,
    initEntry: defaultSdkEntries().init,
    workerRuntime: {
      prepare: async () => {},
      status: () => ({ sdkDir: '/sdk', ready: false, epoch: null }),
      headTag: (marker) => `<script ${marker}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`,
    },
  });
}

describe('Vite page runtime', () => {
  it('always applies in dev and mode-gates sandbox builds', () => {
    const page = runtime();
    expect(page.applies({ command: 'serve', mode: 'production' } as never)).toBe(true);
    expect(page.applies({ command: 'build', mode: 'production' } as never)).toBe(false);
    expect(page.applies({ command: 'build', mode: 'development' } as never)).toBe(true);
    expect(runtime({ swapInBuild: true }).applies({ command: 'build', mode: 'production' } as never)).toBe(true);
  });

  it('owns the sandbox build target and emitted init chunk', () => {
    const page = runtime();
    expect(page.config({}, { command: 'build', mode: 'development' } as never)).toEqual({
      build: { target: 'esnext' },
    });
    page.buildStart((chunk) => {
      expect(chunk).toMatchObject({ type: 'chunk', name: 'pyric-sandbox-init' });
      return 'chunk-ref';
    });
    page.generateBundle((referenceId) => {
      expect(referenceId).toBe('chunk-ref');
      return 'assets/init.js';
    });
    const html = page.transformIndexHtml('<html><head></head></html>');
    expect(html).toContain('data-pyric-sandbox-build');
    expect(html).toContain('/assets/init.js');
    expect(page.transformIndexHtml(html)).toBe(html);
  });

  it('builds the development bootstrap with fallback, AI, and runtime-chip state', () => {
    const page = runtime({
      runtimeChip: { initiallyOpen: true },
      ai: { engine: { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'llama3.2' } },
    });
    const html = page.transformIndexHtml('<html><head></head></html>');
    expect(html).toContain('__PYRIC_FORCE_INPAGE__');
    expect(html).toContain('__PYRIC_AI_ENGINE__');
    expect(html).toContain('llama3.2');
    expect(html).toContain('content="expanded"');
    expect(html).toContain(defaultSdkEntries().init);
    expect(page.transformIndexHtml(html)).toBe(html);
  });

  it('loads mode-specific AI environment during Vite config', () => {
    const page = runtime();
    page.config({}, { command: 'serve', mode: 'development' } as never);
    expect(page.ai()).toEqual({ mode: 'sandbox', engineWire: undefined, proxyUpstream: undefined });
  });
});
