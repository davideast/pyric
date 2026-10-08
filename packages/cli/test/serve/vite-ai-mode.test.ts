/**
 * The AI mode decides which Firebase modules the Vite plugin swaps. Production
 * mode leaves `firebase/ai` to the Firebase SDK and points `firebase/app` at
 * the passthrough app; sandbox mode swaps both to Pyric entries. Executed
 * through a real Vite dev server so the plugin's own mode resolution runs.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';

import { defaultSdkEntries } from '../../src/serve/bundler.js';
import { pyric, type PyricOptions } from '../../src/serve/vite-plugin.js';

// The fixture lives inside the CLI package so bare `firebase/*` imports that
// stay unswapped resolve to the installed Firebase SDK.
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = defaultSdkEntries();
const MAIN = `import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';
import { getFirestore } from 'firebase/firestore';
export { initializeApp, getAI, getGenerativeModel, getFirestore };
`;

let server: ViteDevServer | undefined;
let fixtureRoot: string | undefined;
const savedEnv = { mode: process.env.PYRIC_AI_MODE, passthrough: process.env.PYRIC_AI_PASSTHROUGH };

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  restoreEnv('PYRIC_AI_MODE', savedEnv.mode);
  restoreEnv('PYRIC_AI_PASSTHROUGH', savedEnv.passthrough);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function startServer(options: PyricOptions): Promise<ViteDevServer> {
  fixtureRoot = mkdtempSync(join(cliRoot, '.vite-ai-mode-'));
  writeFileSync(join(fixtureRoot, 'main.ts'), MAIN);
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    root: fixtureRoot,
    plugins: [pyric({ ui: false, ...options })],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  return server;
}

async function resolved(vite: ViteDevServer, specifier: string): Promise<string | undefined> {
  const result = await vite.pluginContainer.resolveId(specifier, join(fixtureRoot!, 'main.ts'));
  return result?.id;
}

function isFirebaseSdkFile(id: string | undefined): boolean {
  return id !== undefined && id.includes(`${sep}node_modules${sep}`) && !id.includes(`${sep}serve${sep}entries${sep}`);
}

describe('Vite AI mode module swap', () => {
  it('production mode leaves firebase/ai to the Firebase SDK and serves the passthrough app', async () => {
    const vite = await startServer({ ai: { mode: 'production' } });
    const ai = await resolved(vite, 'firebase/ai');
    expect(isFirebaseSdkFile(ai)).toBe(true);
    expect(await resolved(vite, 'firebase/app')).toBe(entries['app-ai-passthrough']);
    expect(await resolved(vite, 'firebase/firestore')).toBe(entries.firestore);

    const transformed = await vite.transformRequest('/main.ts');
    const code = transformed?.code ?? '';
    expect(code).toContain('app-ai-passthrough');
    expect(code).not.toMatch(/serve\/entries\/ai\.(ts|js)/);
  }, 60_000);

  it('PYRIC_AI_MODE=production in the environment makes the same decision', async () => {
    process.env.PYRIC_AI_MODE = 'production';
    const vite = await startServer({});
    expect(isFirebaseSdkFile(await resolved(vite, 'firebase/ai'))).toBe(true);
    expect(await resolved(vite, 'firebase/app')).toBe(entries['app-ai-passthrough']);
  }, 60_000);

  it('the plugin option takes precedence over the environment', async () => {
    process.env.PYRIC_AI_MODE = 'production';
    const vite = await startServer({ ai: { mode: 'sandbox' } });
    expect(await resolved(vite, 'firebase/ai')).toBe(entries.ai);
    expect(await resolved(vite, 'firebase/app')).toBe(entries.app);
  }, 60_000);

  it('sandbox mode swaps firebase/ai and firebase/app to Pyric entries', async () => {
    delete process.env.PYRIC_AI_MODE;
    delete process.env.PYRIC_AI_PASSTHROUGH;
    const vite = await startServer({});
    expect(await resolved(vite, 'firebase/ai')).toBe(entries.ai);
    expect(await resolved(vite, 'firebase/app')).toBe(entries.app);
    const code = (await vite.transformRequest('/main.ts'))?.code ?? '';
    expect(code).not.toContain('app-ai-passthrough');
    expect(code).toMatch(/serve\/entries\/ai\.(ts|js)/);
  }, 60_000);
});
