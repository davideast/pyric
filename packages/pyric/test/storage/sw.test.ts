/**
 * `sandboxStorageFetch()` from an app's own service worker: a fetch for a
 * production Storage URL is answered from the sandbox's byte route, and any
 * other fetch is left to the browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { sandboxStorageFetch } from '../../src/storage/sw.js';

const HOST = 'http://localhost:5173';

interface Answered {
  handled: boolean;
  answer: Promise<Response> | undefined;
}

const scope = globalThis as { location?: { origin: string }; fetch: typeof fetch };
const realFetch = scope.fetch;
let requests: Request[] = [];

beforeEach(() => {
  requests = [];
  scope.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response('bytes');
  }, { preconnect: realFetch.preconnect });
});

afterEach(() => {
  scope.fetch = realFetch;
});

function dispatch(request: Request, options: { origin?: string } = { origin: HOST }): Answered {
  let answer: Promise<Response> | undefined;
  const event = { request, respondWith: (response: Promise<Response>) => { answer = response; } };
  const handled = sandboxStorageFetch(event, options);
  return { handled, answer };
}

describe('sandboxStorageFetch', () => {
  it('answers a download URL from the byte route, keeping the token and dropping generation', async () => {
    const production = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/img%2Fa.png?alt=media&token=tok-1&generation=17';
    const { handled, answer } = dispatch(new Request(production));
    expect(handled).toBe(true);
    expect(await (await answer!).text()).toBe('bytes');
    expect(requests.map((request) => request.url)).toEqual([
      `${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/img%2Fa.png?alt=media&token=tok-1`,
    ]);
  });

  it('answers the storage.googleapis.com form', () => {
    const { handled } = dispatch(new Request('https://storage.googleapis.com/demo.appspot.com/a/b.png'));
    expect(handled).toBe(true);
    expect(requests[0]?.url).toBe(`${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/a%2Fb.png?alt=media`);
  });

  it('carries the method and the Range header to the byte route', () => {
    const production = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/v.mp4?alt=media';
    dispatch(new Request(production, { method: 'HEAD', headers: { range: 'bytes=0-9' } }));
    expect(requests[0]?.method).toBe('HEAD');
    expect(requests[0]?.headers.get('range')).toBe('bytes=0-9');
  });

  it('leaves unrelated URLs, Cloud Storage JSON API URLs and writes to the browser', () => {
    const passThrough = [
      new Request('https://example.com/v0/b/demo.appspot.com/o/a.png'),
      new Request(`${HOST}/__pyric/storage/v0/b/demo.appspot.com/o/a.png?alt=media`),
      new Request('https://storage.googleapis.com/storage/v1/b/demo.appspot.com/o/a.png'),
      new Request('https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o?name=a.png', { method: 'POST', body: 'x' }),
      new Request('https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/a.png', { method: 'DELETE' }),
    ];
    for (const request of passThrough) {
      const { handled, answer } = dispatch(request);
      expect({ url: request.url, method: request.method, handled }).toEqual({ url: request.url, method: request.method, handled: false });
      expect(answer).toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it("defaults to the service worker's own origin", async () => {
    const saved = scope.location;
    scope.location = { origin: 'http://127.0.0.1:4000' };
    try {
      const { handled, answer } = dispatch(new Request('https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media'), {});
      expect(handled).toBe(true);
      await answer;
      expect(requests.map((request) => request.url)).toEqual(['http://127.0.0.1:4000/__pyric/storage/v0/b/b/o/x?alt=media']);
    } finally {
      scope.location = saved;
    }
  });

  it('loads no module beyond the URL forms and the byte route', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const root = join(import.meta.dir, '../../src/storage');
    const seen = new Set<string>();
    const pending = [join(root, 'sw.ts')];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
        const isRelative = path.startsWith('.');
        expect({ file: relative(root, file), import: path, isRelative }).toEqual({ file: relative(root, file), import: path, isRelative: true });
        pending.push(join(dirname(file), path.replace(/\.js$/, '.ts')));
      }
    }
    expect([...seen].map((file) => relative(root, file)).sort()).toEqual(['byte-route.ts', 'sw.ts', 'url-forms.ts']);
  });
});
