/**
 * The AI startup status line: `pyric dev`'s answer to "is AI configured at
 * all, and against what?".
 *
 * The boot banner labels hosting, sandbox bundles, rules, Studio, the bridge
 * and persistence; AI was the one live service that boots in total silence, so
 * a developer could not tell from the terminal whether an engine resolved,
 * which model it binds, or where `/__pyric/ai-proxy` forwards. This asserts:
 *   - `pyric dev` (startServe) prints ONE `ai` line in the aligned column
 *     block, present even when nothing is configured (visible absence, the
 *     `• rules    no firestore.rules …` idiom);
 *   - the line names the resolved engine kind, its model binding, and the
 *     proxy endpoint, with credential-bearing URL params redacted the same way
 *     the ai-proxy warning redacts them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { AI_PROXY_DEFAULT_UPSTREAM } from '../../src/serve/ai-proxy.js';
import { formatAiStatusLine, formatAiStatusNote } from '../../src/serve/ai-status.js';
import { loadViteAiEnv } from '../../src/serve/vite-ai-config.js';
import type { ServeLogger } from '../../src/serve/server.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-ai-status-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>p</body></html>');
  return dir;
}

function recordingLogger(): { logger: ServeLogger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { info: (m) => lines.push(m), note: () => {} }, lines };
}

const started: ServeRuntime[] = [];
afterAll(async () => {
  while (started.length) await started.pop()!.handle.stop();
});

const UPSTREAM_ENV = 'PYRIC_AI_PROXY_UPSTREAM';
const originalUpstream = process.env[UPSTREAM_ENV];
afterEach(() => {
  if (originalUpstream === undefined) delete process.env[UPSTREAM_ENV];
  else process.env[UPSTREAM_ENV] = originalUpstream;
});

describe('pyric dev AI startup status', () => {
  it('prints one aligned ai line in the startup banner', async () => {
    delete process.env[UPSTREAM_ENV];
    const cwd = project();
    const { logger, lines } = recordingLogger();
    const runtime = await startServe({
      cwd,
      port: 0,
      cacheRoot: join(cwd, '.cache'),
      logger,
    });
    started.push(runtime);

    const aiLines = lines.filter((line) => /^[✔•] ai\s/.test(line));
    expect(aiLines).toHaveLength(1);
    const [aiLine] = aiLines;

    // Same label column as every other banner line (`✔ hosting  …`).
    const hosting = lines.find((line) => line.startsWith('✔ hosting'))!;
    expect(hosting.slice(0, 11)).toBe('✔ hosting  ');

    // The CLI has no AI surface of its own, so the honest report is: no
    // server-side engine, plus where the proxy forwards.
    expect(aiLine.slice(0, 11)).toBe('• ai       ');
    expect(aiLine).toContain('/__pyric/ai-proxy');
    expect(aiLine).toContain(AI_PROXY_DEFAULT_UPSTREAM);
  }, 120_000);

  it('names the engine kind, the model binding, and the proxy endpoint', () => {
    delete process.env[UPSTREAM_ENV];
    expect(formatAiStatusLine({ engine: { kind: 'openai', model: 'llama3.1' } })).toBe(
      `✔ ai       openai (model llama3.1) → /__pyric/ai-proxy → ${AI_PROXY_DEFAULT_UPSTREAM} (default)`,
    );
    expect(formatAiStatusLine({ engine: { kind: 'openai' } })).toContain('no model pinned');
    expect(formatAiStatusLine({ engine: { kind: 'scripted', script: [{}, {}] } })).toContain(
      '2 canned response(s)',
    );
  });

  it('describes Node AI as direct upstream traffic', () => {
    const line = formatAiStatusLine({
      hosted: true, engine: { kind: 'openai', model: 'local-model' },
      proxyUpstream: 'http://127.0.0.1:11434/v1',
    });
    expect(line).toContain('openai (model local-model) → http://127.0.0.1:11434/v1');
    expect(line).toContain('direct from Node');
    expect(line).not.toContain('/__pyric/ai-proxy');
  });

  it('reports a gemini engine without ever printing the key', () => {
    expect(formatAiStatusLine({ engine: { kind: 'gemini', apiKey: 'AIzaSyTOPSECRET' } })).toBe(
      '✔ ai       gemini (API key set) → https://generativelanguage.googleapis.com',
    );
  });

  describe('gemini key from the environment', () => {
    const names = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;
    const cleared = [...names, 'VITE_GEMINI_API_KEY'] as const;
    const saved = new Map<string, string | undefined>();
    beforeEach(() => {
      for (const name of cleared) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
    });
    afterEach(() => {
      for (const name of cleared) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('says no key when the option and every variable are absent', () => {
      expect(formatAiStatusLine({ engine: { kind: 'gemini' } })).toContain('no API key');
    });

    it.each(names)('says the key is set when only %s has it', (name) => {
      process.env[name] = 'AIzaSyFromEnv';
      const line = formatAiStatusLine({ engine: { kind: 'gemini' } });
      expect(line).toContain('gemini (API key set)');
      expect(line).not.toContain('AIzaSyFromEnv');
    });

    it('says no key for a whitespace-only value', () => {
      process.env.GEMINI_API_KEY = '   ';
      expect(formatAiStatusLine({ engine: { kind: 'gemini' } })).toContain('no API key');
    });

    it('follows the engine: a blank earlier variable shadows a later real one', () => {
      process.env.GEMINI_API_KEY = '';
      process.env.GOOGLE_GENAI_API_KEY = 'AIzaSyFromEnv';
      expect(formatAiStatusLine({ engine: { kind: 'gemini' } })).toContain('no API key');
    });

    it('does not count VITE_GEMINI_API_KEY as a key, because Vite serves it to the browser (#1632)', () => {
      process.env.VITE_GEMINI_API_KEY = 'AIzaSyFromEnv';
      expect(formatAiStatusLine({ engine: { kind: 'gemini' } })).toContain('no API key');
    });

    it('sees a key that only a project .env holds once loadViteAiEnv has run (#950)', () => {
      const root = mkdtempSync(join(tmpdir(), 'pyric-ai-env-'));
      writeFileSync(join(root, '.env'), 'GEMINI_API_KEY=AIzaSyFromDotEnv\n');
      loadViteAiEnv('development', root, undefined);
      expect(formatAiStatusNote({ hosted: true, engine: { kind: 'gemini' } })).toContain(
        'gemini (API key set)',
      );
    });
  });

  it('reports production mode as the Firebase SDK, with no engine and no key demand', () => {
    const line = formatAiStatusLine({ mode: 'production' });
    expect(line).toBe(
      "✔ ai       production passthrough; firebase/ai is the Firebase SDK, calling Google AI or Vertex AI with the app's initializeApp config",
    );
    expect(line).not.toContain('GEMINI_API_KEY');
    expect(formatAiStatusNote({ mode: 'production', hosted: true })).toContain('[pyric] ai: production passthrough');
  });

  it('redacts credential params in the proxy upstream', () => {
    process.env[UPSTREAM_ENV] = 'https://gateway.example/v1?key=sk-live-abcdef';
    const line = formatAiStatusLine({});
    expect(line).toContain('https://gateway.example/v1?key=***');
    expect(line).not.toContain('sk-live-abcdef');
    expect(line).toContain(`(${UPSTREAM_ENV})`);
  });

  it('names the option that set an explicitly configured upstream', () => {
    // A plugin-configured upstream is neither the env var nor the default, and
    // used to render with no provenance at all.
    process.env[UPSTREAM_ENV] = 'http://from-the-env:1234/v1';
    const line = formatAiStatusLine({ proxyUpstream: 'http://from-the-plugin:9999/v1' });
    expect(line).toContain('http://from-the-plugin:9999/v1 (ai.proxyUpstream)');
    expect(line).not.toContain('from-the-env');
  });

  it('offers the Vite dev-server flavor of the same report', () => {
    delete process.env[UPSTREAM_ENV];
    expect(formatAiStatusNote({ engine: { kind: 'openai', model: 'llama3.1' } })).toBe(
      `  ✔ [pyric] ai: openai (model llama3.1) → /__pyric/ai-proxy → ${AI_PROXY_DEFAULT_UPSTREAM} (default)`,
    );
  });
});
