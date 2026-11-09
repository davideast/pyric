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

  it('puts the sandbox init script ahead of the page own scripts', () => {
    const page = runtime();
    page.config({}, { command: 'build', mode: 'development' } as never);
    page.buildStart(() => 'chunk-ref');
    page.generateBundle(() => 'assets/init.js');
    const html = page.transformIndexHtml(
      '<html><head><script type="module" crossorigin src="/assets/app.js"></script></head><body></body></html>',
    );
    expect(html.indexOf('/assets/init.js')).toBeLessThan(html.indexOf('/assets/app.js'));
  });

  it('puts the development bootstrap ahead of a script the page has in its head', () => {
    const page = runtime();
    const html = page.transformIndexHtml(
      '<html><head><script type="module" src="/src/main.tsx"></script></head><body></body></html>',
    );
    expect(html.indexOf(defaultSdkEntries().init)).toBeLessThan(html.indexOf('/src/main.tsx'));
  });

  it('loads mode-specific AI environment during Vite config', () => {
    const page = runtime();
    page.config({}, { command: 'serve', mode: 'development' } as never);
    expect(page.ai()).toEqual({ mode: 'sandbox', engineWire: undefined, proxyUpstream: undefined });
  });

  it('never injects engine baseUrl userinfo into served page HTML (#1766)', () => {
    const geminiPage = runtime({
      ai: {
        engine: {
          kind: 'gemini',
          baseUrl: `http://gateway-user:gateway-secret-1766 "q'@127.0.0.1:9999`,
        },
      },
    });
    const geminiHtml = geminiPage.transformIndexHtml('<html><head></head></html>');
    expect(geminiHtml).toContain('__PYRIC_AI_ENGINE__={"kind":"gemini"}');
    expect(geminiHtml).not.toContain('gateway-user');
    expect(geminiHtml).not.toContain('gateway-secret-1766');
    expect(geminiHtml).not.toContain('127.0.0.1:9999');

    const openaiPage = runtime({
      hosted: true,
      ai: {
        engine: {
          kind: 'openai',
          baseUrl: `http://gateway-user:gateway-secret-1766 "q'@127.0.0.1:9999/v1`,
          model: 'llama3.2',
        },
      },
    });
    const openaiHtml = openaiPage.transformIndexHtml('<html><head></head></html>');
    expect(openaiHtml).not.toContain('gateway-user');
    expect(openaiHtml).not.toContain('gateway-secret-1766');
    expect(openaiHtml).toContain('http://127.0.0.1:9999/v1');
  });
});

describe('Vite page runtime: a Gemini key Vite would serve to the browser (#1632, #1659)', () => {
  const FAKE_KEY = 'AIzaFAKE-1659-runtime';
  const NAMES = ['VITE_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;

  /** Run `body` with only `values` among the Gemini key names in the shell environment. */
  function withKeys(values: Partial<Record<(typeof NAMES)[number], string>>, body: () => void): void {
    const before = new Map(NAMES.map((name) => [name, process.env[name]]));
    for (const name of NAMES) delete process.env[name];
    Object.assign(process.env, values);
    try {
      body();
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  /** Start a dev server's config hooks: `config`, then `configResolved` with the app's `envPrefix`. */
  function startDevServer(envPrefix?: string | string[], env: Record<string, unknown> = { command: 'serve', mode: 'development' }): void {
    const page = runtime();
    page.config({}, env as never);
    page.configResolved({ envPrefix });
  }

  function refusal(run: () => void): string {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  }

  it('refuses VITE_GEMINI_API_KEY under the default envPrefix and says to rename it', () => {
    withKeys({ VITE_GEMINI_API_KEY: FAKE_KEY }, () => {
      const message = refusal(() => startDevServer());
      expect(message).toContain('VITE_GEMINI_API_KEY is set');
      expect(message).toContain('Rename it to GEMINI_API_KEY');
      expect(message).not.toContain(FAKE_KEY);
    });
  });

  it('leaves VITE_GEMINI_API_KEY alone when envPrefix does not cover it, because Vite never serves it', () => {
    withKeys({ VITE_GEMINI_API_KEY: FAKE_KEY }, () => {
      expect(() => startDevServer('APP_')).not.toThrow();
    });
  });

  it('refuses GEMINI_API_KEY when envPrefix covers it, and names the prefix and a name it does not cover', () => {
    withKeys({ GEMINI_API_KEY: FAKE_KEY }, () => {
      const message = refusal(() => startDevServer(['VITE_', 'GEMINI_']));
      expect(message).toContain('GEMINI_API_KEY is set');
      expect(message).toContain('starts with GEMINI_');
      expect(message).toContain('Remove GEMINI_ from envPrefix');
      expect(message).toContain('GOOGLE_GENAI_API_KEY');
      expect(message).not.toContain(FAKE_KEY);
    });
  });

  it('does not advise a name envPrefix also covers', () => {
    withKeys({ VITE_GEMINI_API_KEY: FAKE_KEY }, () => {
      const message = refusal(() => startDevServer(['VITE_', 'GEMINI_', 'GOOGLE_']));
      expect(message).toContain('VITE_GEMINI_API_KEY is set');
      expect(message).not.toContain('Rename it to');
      expect(message).toContain('Change envPrefix in your Vite config');
    });
  });

  it('refuses GOOGLE_GENAI_API_KEY when envPrefix covers it', () => {
    withKeys({ GOOGLE_GENAI_API_KEY: FAKE_KEY }, () => {
      expect(refusal(() => startDevServer('GOOGLE_'))).toContain('GOOGLE_GENAI_API_KEY is set');
    });
  });

  it('leaves GEMINI_API_KEY alone under the default envPrefix', () => {
    withKeys({ GEMINI_API_KEY: FAKE_KEY }, () => {
      expect(() => startDevServer()).not.toThrow();
    });
  });

  it('leaves vite preview alone, because it serves build output that never held the key', () => {
    withKeys({ VITE_GEMINI_API_KEY: FAKE_KEY }, () => {
      expect(() => startDevServer(undefined, { command: 'serve', mode: 'production', isPreview: true })).not.toThrow();
    });
  });

  it('leaves a sandbox build alone', () => {
    withKeys({ VITE_GEMINI_API_KEY: FAKE_KEY }, () => {
      expect(() => startDevServer(undefined, { command: 'build', mode: 'development' })).not.toThrow();
    });
  });
});
