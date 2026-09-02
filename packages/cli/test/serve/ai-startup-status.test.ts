/**
 * The AI startup status line — `pyric dev`'s answer to "is AI configured at
 * all, and against what?".
 *
 * The boot banner labels hosting, sandbox bundles, rules, Studio, the bridge
 * and persistence; AI was the one live service that boots in total silence, so
 * a developer could not tell from the terminal whether an engine resolved,
 * which model it binds, or where `/__pyric/ai-proxy` forwards. This asserts:
 *   - `pyric dev` (startServe) prints ONE `ai` line in the aligned column
 *     block, present even when nothing is configured (visible absence — the
 *     `• rules    no firestore.rules …` idiom);
 *   - the line names the resolved engine kind, its model binding, and the
 *     proxy endpoint, with credential-bearing URL params redacted the same way
 *     the ai-proxy warning redacts them.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { AI_PROXY_DEFAULT_UPSTREAM } from '../../src/serve/ai-proxy.js';
import { formatAiStatusLine, formatAiStatusNote } from '../../src/serve/ai-status.js';
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

  it('reports a gemini engine without ever printing the key', () => {
    expect(
      formatAiStatusLine({ engine: { kind: 'gemini', apiKey: 'AIzaSyTOPSECRET' }, mode: 'production' }),
    ).toBe(
      '✔ ai       gemini (production passthrough, API key set) → https://generativelanguage.googleapis.com',
    );
    expect(formatAiStatusLine({ engine: { kind: 'gemini' } })).toContain('no API key');
  });

  it('redacts credential params in the proxy upstream', () => {
    process.env[UPSTREAM_ENV] = 'https://gateway.example/v1?key=sk-live-abcdef';
    const line = formatAiStatusLine({});
    expect(line).toContain('https://gateway.example/v1?key=***');
    expect(line).not.toContain('sk-live-abcdef');
    expect(line).toContain(`(${UPSTREAM_ENV})`);
  });

  it('offers the Vite dev-server flavor of the same report', () => {
    delete process.env[UPSTREAM_ENV];
    expect(formatAiStatusNote({ engine: { kind: 'openai', model: 'llama3.1' } })).toBe(
      `  ✔ [pyric] ai: openai (model llama3.1) → /__pyric/ai-proxy → ${AI_PROXY_DEFAULT_UPSTREAM} (default)`,
    );
  });
});
