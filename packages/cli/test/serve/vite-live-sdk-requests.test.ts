/**
 * The page gate under open live rows (`vite-live-sdk-requests.ts`): a request
 * for an installed SDK file the rows loaded passes only at a URL Vite wrote
 * for it into an importer, which Vite records in its client module graph.
 * Every other URL that reaches the file, however Vite would normalize it,
 * gets a module that throws the rows' refusal, because the browser keys
 * each URL as its own module.
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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-sdk-gate-')));
const packageDir = join(root, 'node_modules/@firebase/firestore');
const sdkFile = join(packageDir, 'dist/index.esm.js');
mkdirSync(join(packageDir, 'dist'), { recursive: true });
writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@firebase/firestore', type: 'module' }));
writeFileSync(sdkFile, 'export function initializeFirestore() {}\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const PATH = '/node_modules/@firebase/firestore/dist/index.esm.js';

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

interface Node {
  url: string;
  lastHMRTimestamp: number;
}

interface Answer {
  passed: boolean;
  body: string;
}

interface GateOptions {
  /** The URLs Vite wrote for the SDK file, as its module graph holds them; one node each. */
  written: string[];
  /** Vite 5 keeps the graph on the server; Vite 6 and later on the client environment. */
  shape?: 'vite5' | 'vite6';
  /** The optimizer's current hash in memory, which the gate must not read. */
  currentHash?: string;
  base?: string;
}

/** A gate on a stand-in dev server whose client module graph holds `written` for the SDK file. */
function gate(options: GateOptions): { ask: (url: string) => Promise<Answer>; nodes: Node[] } {
  let middleware: Middleware | undefined;
  const nodes: Node[] = options.written.map((url) => ({ url, lastHMRTimestamp: 0 }));
  const moduleGraph = {
    urlToModuleMap: new Map(nodes.map((node) => [node.url, node])),
    getModulesByFile: (file: string) => (file === sdkFile ? new Set(nodes) : undefined),
  };
  const depsOptimizer = { metadata: { browserHash: options.currentHash ?? 'current' } };
  const placement = options.shape === 'vite5'
    ? { moduleGraph }
    : { environments: { client: { moduleGraph, depsOptimizer } } };
  const server = {
    config: { root, base: options.base ?? '/', cacheDir: join(root, 'node_modules/.vite') },
    middlewares: { use: (fn: Middleware) => { middleware = fn; } },
    ...placement,
  };
  const rows = suppliedRows((specifier) => Object.assign(new Error(`@pyric/live: ${specifier} is refused in live mode.`), { code: 'PYRIC_LIVE_REFUSED' }));
  rows.open({} as unknown as RowModulePackage);
  rows.liveSdkUrls.add(pathToFileURL(sdkFile).href);
  attachLiveSdkRequestGate(server as unknown as Parameters<typeof attachLiveSdkRequestGate>[0], rows);
  const ask = (url: string) => new Promise<Answer>((resolve, reject) => {
    const response = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body: string) => resolve({ passed: false, body }),
    };
    const request = { url } as IncomingMessage;
    middleware!(request, response as unknown as ServerResponse, () => resolve({ passed: true, body: '' }));
    setTimeout(() => reject(new Error(`no answer for ${url}`)), 10_000);
  });
  return { ask, nodes };
}

describe('a request for an SDK file the live rows loaded', () => {
  const { ask } = gate({ written: [`${PATH}?v=abc123`] });

  it('passes at the URL Vite wrote for it', async () => {
    expect((await ask(`${PATH}?v=abc123`)).passed).toBe(true);
  });

  const refused: Record<string, string> = {
    'a t= query': `${PATH}?v=abc123&t=1700000000000`,
    'a trailing &': `${PATH}?v=abc123&`,
    'a doubled &': `${PATH}?v=abc123&&`,
    'an encoded query name': `${PATH}?%76=abc123`,
    'an encoded path segment': '/node_modules/%40firebase/firestore/dist/index.esm.js?v=abc123',
    'another v=': `${PATH}?v=other`,
    'no query': PATH,
    'the /@fs/ path': `/@fs${sdkFile}?v=abc123`,
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

describe('the URLs Vite wrote, read from its module graph', () => {
  it("keep passing when the optimizer reruns with a new hash and no reload, while the new hash's URL does not", async () => {
    // Vite keeps the hash it already wrote in memory when a rerun needs no reload; the gate reads the graph, not the hash.
    const { ask } = gate({ written: [`${PATH}?v=first`], currentHash: 'second' });
    expect((await ask(`${PATH}?v=first`)).passed).toBe(true);
    expect((await ask(`${PATH}?v=second`)).passed).toBe(false);
  });

  it('come from the server object on Vite 5, with no optimizer and no metadata file on disk (a cold start)', async () => {
    const { ask } = gate({ written: [`${PATH}?v=cold`], shape: 'vite5' });
    expect((await ask(`${PATH}?v=cold`)).passed).toBe(true);
    expect((await ask(`${PATH}?v=cold&`)).passed).toBe(false);
  });

  it('pass a URL Vite wrote with no query, and nothing for a file no importer was given yet', async () => {
    expect((await gate({ written: [PATH] }).ask(PATH)).passed).toBe(true);
    expect((await gate({ written: [] }).ask(`${PATH}?v=abc123`)).passed).toBe(false);
  });

  it("include the t= Vite puts first once the file has an HMR timestamp", async () => {
    const { ask, nodes } = gate({ written: [`${PATH}?v=abc123`] });
    nodes[0]!.lastHMRTimestamp = 1700000000000;
    expect((await ask(`${PATH}?t=1700000000000&v=abc123`)).passed).toBe(true);
    expect((await ask(`${PATH}?v=abc123&t=1700000000000`)).passed).toBe(false);
  });

  it("are requested under Vite's base", async () => {
    const { ask } = gate({ written: [`${PATH}?v=abc123`], base: '/app/' });
    expect((await ask(`/app${PATH}?v=abc123`)).passed).toBe(true);
    expect((await ask(`/app${PATH}?v=abc123&`)).passed).toBe(false);
  });
});
