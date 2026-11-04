/**
 * The page gate under open live rows (`vite-live-sdk-requests.ts`): a request
 * for an installed SDK file the rows loaded passes only at the exact URL Vite
 * writes for it. Every other URL that reaches the file, however Vite would
 * normalize it, gets a module that throws the rows' refusal, because the
 * browser keys each URL as its own module.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachLiveSdkRequestGate } from '../../src/serve/vite-live-sdk-requests.js';
import type { RowModulePackage } from '../../src/serve/vite-live-package.js';
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';

const HASH = 'abc123';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-sdk-gate-')));
const packageDir = join(root, 'node_modules/@firebase/firestore');
const sdkFile = join(packageDir, 'dist/index.esm.js');
mkdirSync(join(packageDir, 'dist'), { recursive: true });
writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@firebase/firestore', type: 'module' }));
writeFileSync(sdkFile, 'export function initializeFirestore() {}\n');
const cacheDir = join(root, 'node_modules/.vite');

afterAll(() => rmSync(root, { recursive: true, force: true }));

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

interface Answer {
  passed: boolean;
  body: string;
}

/** A gate on a stand-in dev server; `hash` is the optimizer's, in memory or in its metadata file. */
function gate(options: { hash: string | null; from: 'memory' | 'file' }): (url: string) => Promise<Answer> {
  let middleware: Middleware | undefined;
  const environments = options.from === 'memory' && options.hash !== null
    ? { client: { depsOptimizer: { metadata: { browserHash: options.hash } } } }
    : undefined;
  if (options.from === 'file' && options.hash !== null) {
    mkdirSync(join(cacheDir, 'deps'), { recursive: true });
    writeFileSync(join(cacheDir, 'deps/_metadata.json'), JSON.stringify({ browserHash: options.hash }));
  }
  const server = {
    config: { root, base: '/', cacheDir: options.from === 'file' ? cacheDir : join(root, 'no-cache') },
    middlewares: { use: (fn: Middleware) => { middleware = fn; } },
    environments,
  };
  const rows = suppliedRows((specifier) => Object.assign(new Error(`@pyric/live: ${specifier} is refused in live mode.`), { code: 'PYRIC_LIVE_REFUSED' }));
  rows.open({} as unknown as RowModulePackage);
  rows.liveSdkUrls.add(pathToFileURL(sdkFile).href);
  attachLiveSdkRequestGate(server as unknown as Parameters<typeof attachLiveSdkRequestGate>[0], rows);
  return (url) => new Promise((resolve, reject) => {
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body: string) => resolve({ passed: false, body }),
    };
    const request = { url } as IncomingMessage;
    middleware!(request, response as unknown as ServerResponse, () => resolve({ passed: true, body: '' }));
    setTimeout(() => reject(new Error(`no answer for ${url}`)), 10_000);
  });
}

const WRITTEN = `/node_modules/@firebase/firestore/dist/index.esm.js?v=${HASH}`;

describe('a request for an SDK file the live rows loaded', () => {
  const ask = gate({ hash: HASH, from: 'memory' });

  it('passes at the URL Vite writes for it', async () => {
    expect((await ask(WRITTEN)).passed).toBe(true);
  });

  const refused: Record<string, string> = {
    'a t= query': `${WRITTEN}&t=1700000000000`,
    'a trailing &': `${WRITTEN}&`,
    'a doubled &': `${WRITTEN}&&`,
    'an encoded query name': `/node_modules/@firebase/firestore/dist/index.esm.js?%76=${HASH}`,
    'an encoded path segment': `/node_modules/%40firebase/firestore/dist/index.esm.js?v=${HASH}`,
    'another v=': '/node_modules/@firebase/firestore/dist/index.esm.js?v=other',
    'no query': '/node_modules/@firebase/firestore/dist/index.esm.js',
    'the /@fs/ path': `/@fs${sdkFile}?v=${HASH}`,
  };
  for (const [name, url] of Object.entries(refused)) {
    it(`is refused under ${name}`, async () => {
      const answer = await ask(url);
      expect(answer.passed).toBe(false);
      expect(answer.body).toContain('@pyric/live: @firebase/firestore is refused in live mode.');
      expect(answer.body).toContain('PYRIC_LIVE_REFUSED');
      expect(answer.body).toContain('initializeFirestore');
    });
  }

  it('leaves every other file alone', async () => {
    expect((await ask('/node_modules/@firebase/firestore/package.json?x=1')).passed).toBe(true);
    expect((await ask('/main.js?t=1')).passed).toBe(true);
  });
});

describe("the optimizer's hash", () => {
  it("comes from the metadata file when the server object holds no optimizer (Vite 5)", async () => {
    const ask = gate({ hash: HASH, from: 'file' });
    expect((await ask(WRITTEN)).passed).toBe(true);
    expect((await ask(`${WRITTEN}&`)).passed).toBe(false);
  });

  it('is absent when neither says, and then only the URL with no query passes', async () => {
    const ask = gate({ hash: null, from: 'memory' });
    expect((await ask('/node_modules/@firebase/firestore/dist/index.esm.js')).passed).toBe(true);
    expect((await ask(WRITTEN)).passed).toBe(false);
  });
});
