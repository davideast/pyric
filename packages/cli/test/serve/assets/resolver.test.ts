import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveManifest, type AssetManifest } from '../../../src/serve/assets/manifest.js';
import {
  createAssetResolver,
  type AssetRequest,
  type AssetSource,
} from '../../../src/serve/assets/resolver.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pyric-assets-resolver-'));

const req = (key: string, seed = key): AssetRequest => ({ key, seed, context: {} });

const failingFallback = () => {
  throw new Error('fallback should not be called in this test');
};

const fallbackBytes = (label: string) => ({
  data: new TextEncoder().encode(`fallback:${label}`),
  contentType: 'image/png',
});

function fakeResponse(opts: {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: Uint8Array;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null) },
    arrayBuffer: async () => (opts.body ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

describe('createAssetResolver: keyed cache', () => {
  it.each(['data', 'url'] as const)('retains every concurrent %s download across resolver restarts', async (kind) => {
    const dir = tmp();
    saveManifest(dir, { version: 1, name: 'Portraits', images: [{ file: 'pool.png' }] });
    const resolver = createAssetResolver({
      dir,
      source: ({ key }) => kind === 'url'
        ? { url: `https://example.test/${key}` }
        : { data: new TextEncoder().encode(key), contentType: 'image/png' },
      fetchImpl: async (url) => new Response(String(url).split('/').at(-1), { headers: { 'content-type': 'image/png' } }),
      fallback: failingFallback,
      sourceDeadlineMs: 1000,
    });
    const keys = ['alice', 'bob', 'charlie'];
    await Promise.all(keys.map((key) => resolver.resolve(req(key))));
    const restarted = createAssetResolver({ dir, fallback: failingFallback });
    for (const key of keys) {
      const result = await restarted.resolve(req(key));
      expect(result.origin).toBe('cache');
      expect(new TextDecoder().decode(result.data)).toBe(key);
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.name).toBe('Portraits');
    expect(manifest.images).toContainEqual({ file: 'pool.png' });
    expect(manifest.images).toHaveLength(4);
  });

  it('serves a materialised manifest entry without touching source or fallback', async () => {
    const dir = tmp();
    const bytes = new TextEncoder().encode('hero-bytes');
    writeFileSync(join(dir, 'hero.png'), bytes);
    saveManifest(dir, { version: 1, images: [{ file: 'hero.png', contentType: 'image/png', key: 'hero' }] });

    const resolver = createAssetResolver({ dir, fallback: failingFallback });
    const result = await resolver.resolve(req('hero'));

    expect(result.origin).toBe('cache');
    expect(result.contentType).toBe('image/png');
    expect(Buffer.from(result.data)).toEqual(Buffer.from(bytes));
  });
});

describe('createAssetResolver: pool pick', () => {
  const pool: AssetManifest = {
    version: 1,
    images: [
      { file: 'p0.png', contentType: 'image/png' },
      { file: 'p1.png', contentType: 'image/png' },
      { file: 'p2.png', contentType: 'image/png' },
    ],
  };

  function makePoolDir(): string {
    const dir = tmp();
    for (const image of pool.images) {
      writeFileSync(join(dir, image.file), new TextEncoder().encode(image.file));
    }
    saveManifest(dir, pool);
    return dir;
  }

  it('is deterministic for a given seed, across independent resolver instances', async () => {
    const dir = makePoolDir();
    const resolverA = createAssetResolver({ dir, fallback: failingFallback });
    const resolverB = createAssetResolver({ dir, fallback: failingFallback });

    const a1 = await resolverA.resolve(req('any-key', 'seed-fixed'));
    const a2 = await resolverA.resolve(req('any-key', 'seed-fixed'));
    const b1 = await resolverB.resolve(req('any-key', 'seed-fixed'));

    expect(a1.origin).toBe('pool');
    expect(Buffer.from(a1.data)).toEqual(Buffer.from(a2.data));
    expect(Buffer.from(a1.data)).toEqual(Buffer.from(b1.data));
  });

  it('spreads different seeds across the pool', async () => {
    const dir = makePoolDir();
    const resolver = createAssetResolver({ dir, fallback: failingFallback });

    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await resolver.resolve(req('any-key', `seed-${i}`));
      picks.add(new TextDecoder().decode(result.data));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('never writes a cache entry for a pool pick', async () => {
    const dir = makePoolDir();
    const resolver = createAssetResolver({ dir, fallback: failingFallback });
    await resolver.resolve(req('any-key'));
    const manifestOnDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifestOnDisk).toEqual(pool);
  });
});

describe('createAssetResolver: source, { data } result', () => {
  it('caches on first resolve; second resolve is served from cache without calling source again', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = () => {
      calls++;
      return { data: new TextEncoder().encode('generated'), contentType: 'image/png' };
    };
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    const first = await resolver.resolve(req('avatar-1'));
    expect(first.origin).toBe('source');
    expect(calls).toBe(1);
    expect(existsSync(join(dir, 'avatar-1.png'))).toBe(true);

    const second = await resolver.resolve(req('avatar-1'));
    expect(second.origin).toBe('cache');
    expect(calls).toBe(1);
    expect(Buffer.from(second.data)).toEqual(Buffer.from(first.data));
  });

  it('caches into a directory that does not exist yet', async () => {
    // The default cache dir (.pyric/assets/avatars) is absent until the
    // first source result materialises it; the write must create it.
    const dir = join(tmp(), 'nested', 'not-yet-created');
    let calls = 0;
    const source: AssetSource = () => {
      calls++;
      return { data: new TextEncoder().encode('generated'), contentType: 'image/jpeg' };
    };
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    const first = await resolver.resolve(req('avatar-1'));
    expect(first.origin).toBe('source');
    expect(existsSync(join(dir, 'avatar-1.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);

    const second = await resolver.resolve(req('avatar-1'));
    expect(second.origin).toBe('cache');
    expect(calls).toBe(1);
  });

  it('takes precedence over a pool even when the manifest has pool images', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'pool.png'), new TextEncoder().encode('pool'));
    saveManifest(dir, { version: 1, images: [{ file: 'pool.png', contentType: 'image/png' }] });
    const source: AssetSource = () => ({ data: new TextEncoder().encode('sourced'), contentType: 'image/png' });
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('source');
  });

  it('rejects an unknown content type: fallback served, nothing cached', async () => {
    const dir = tmp();
    const source: AssetSource = () => ({ data: new TextEncoder().encode('x'), contentType: 'image/gif' });
    const resolver = createAssetResolver({ dir, source, fallback: () => fallbackBytes('unknown-type') });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('fallback');
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });
});

describe('createAssetResolver: source, { url } result', () => {
  it('fetches via the injected fetchImpl and caches the result', async () => {
    const dir = tmp();
    const body = new TextEncoder().encode('fetched-bytes');
    let fetchCalls = 0;
    const fetchImpl = (async (url: string) => {
      fetchCalls++;
      expect(url).toBe('https://example.test/img.webp');
      return fakeResponse({ ok: true, status: 200, contentType: 'image/webp', body });
    }) as unknown as typeof fetch;
    const source: AssetSource = () => ({ url: 'https://example.test/img.webp' });
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback, fetchImpl });

    const first = await resolver.resolve(req('remote-1'));
    expect(first.origin).toBe('source');
    expect(first.contentType).toBe('image/webp');
    expect(Buffer.from(first.data)).toEqual(Buffer.from(body));
    expect(fetchCalls).toBe(1);
    expect(existsSync(join(dir, 'remote-1.webp'))).toBe(true);

    const second = await resolver.resolve(req('remote-1'));
    expect(second.origin).toBe('cache');
    expect(fetchCalls).toBe(1);
  });

  it('non-2xx response: fallback served, nothing cached', async () => {
    const dir = tmp();
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
    const source: AssetSource = () => ({ url: 'https://example.test/missing.png' });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('404'),
      fetchImpl,
    });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('fallback');
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });

  it('unknown response content type: fallback served, nothing cached', async () => {
    const dir = tmp();
    const fetchImpl = (async () =>
      fakeResponse({ ok: true, status: 200, contentType: 'image/gif', body: new Uint8Array([1]) })) as unknown as typeof fetch;
    const source: AssetSource = () => ({ url: 'https://example.test/img.gif' });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('bad-type'),
      fetchImpl,
    });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('fallback');
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });

  it('network error from fetchImpl: fallback served, nothing cached', async () => {
    const dir = tmp();
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const source: AssetSource = () => ({ url: 'https://example.test/img.png' });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('network-error'),
      fetchImpl,
    });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('fallback');
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });
});

describe('createAssetResolver: source deadline', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('serves interim fallback bytes past the deadline, then upgrades to the cached result', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = async () => {
      calls++;
      await sleep(40);
      return { data: new TextEncoder().encode('portrait'), contentType: 'image/jpeg' };
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('interim'),
      sourceDeadlineMs: 5,
    });

    const first = await resolver.resolve(req('slow'));
    expect(first.origin).toBe('interim');
    expect(Buffer.from(first.data)).toEqual(Buffer.from(fallbackBytes('interim').data));

    await sleep(60); // let the background generation land in the cache
    const second = await resolver.resolve(req('slow'));
    expect(second.origin).toBe('cache');
    expect(Buffer.from(second.data)).toEqual(Buffer.from(new TextEncoder().encode('portrait')));
    expect(calls).toBe(1);
  });

  it('a concurrent request during generation also gets interim, and the source still runs once', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = async () => {
      calls++;
      await sleep(40);
      return { data: new TextEncoder().encode('portrait'), contentType: 'image/jpeg' };
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('interim'),
      sourceDeadlineMs: 5,
    });

    const [a, b] = await Promise.all([resolver.resolve(req('k')), resolver.resolve(req('k'))]);
    expect(a.origin).toBe('interim');
    expect(b.origin).toBe('interim');
    expect(calls).toBe(1);
  });

  it('a source failure after an interim response caches nothing, and the next resolve retries', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = async () => {
      calls++;
      await sleep(20);
      if (calls === 1) throw new Error('quota');
      return { data: new TextEncoder().encode('portrait'), contentType: 'image/jpeg' };
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('interim'),
      sourceDeadlineMs: 5,
    });

    const first = await resolver.resolve(req('flaky'));
    expect(first.origin).toBe('interim');

    await sleep(40); // failed attempt settles; nothing may be cached
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);

    const second = await resolver.resolve(req('flaky'));
    expect(second.origin).toBe('interim'); // retry kicked off, still slow
    await sleep(40);
    const third = await resolver.resolve(req('flaky'));
    expect(third.origin).toBe('cache');
    expect(calls).toBe(2);
  });

  it('by default an asynchronous source yields an instant interim rather than blocking', async () => {
    const dir = tmp();
    const source: AssetSource = async () => {
      await sleep(40);
      return { data: new TextEncoder().encode('portrait'), contentType: 'image/jpeg' };
    };
    // No sourceDeadlineMs: the default must not make the first paint wait.
    const resolver = createAssetResolver({ dir, source, fallback: () => fallbackBytes('interim') });

    const started = Date.now();
    const first = await resolver.resolve(req('slow'));
    expect(first.origin).toBe('interim');
    expect(Date.now() - started).toBeLessThan(20);

    await sleep(60);
    expect((await resolver.resolve(req('slow'))).origin).toBe('cache');
  });

  it('tells the fallback which case it is serving, so an interim can look provisional', async () => {
    const dir = tmp();
    const kinds: string[] = [];
    const fallback = (_req: AssetRequest, kind: 'fallback' | 'interim') => {
      kinds.push(kind);
      return fallbackBytes(kind);
    };

    const slow: AssetSource = async () => {
      await sleep(40);
      return { data: new TextEncoder().encode('portrait'), contentType: 'image/jpeg' };
    };
    await createAssetResolver({ dir, source: slow, fallback }).resolve(req('slow'));

    const failing: AssetSource = () => {
      throw new Error('boom');
    };
    await createAssetResolver({ dir: tmp(), source: failing, fallback }).resolve(req('broken'));

    expect(kinds).toEqual(['interim', 'fallback']);
  });

  it('by default a synchronous source still answers directly, without an interim', async () => {
    const dir = tmp();
    const source: AssetSource = () => ({
      data: new TextEncoder().encode('quick'),
      contentType: 'image/png',
    });
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    expect((await resolver.resolve(req('fast'))).origin).toBe('source');
  });

  it('a source faster than an explicit deadline behaves exactly as before', async () => {
    const dir = tmp();
    const source: AssetSource = () => ({
      data: new TextEncoder().encode('quick'),
      contentType: 'image/png',
    });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: failingFallback,
      sourceDeadlineMs: 1000,
    });

    const result = await resolver.resolve(req('fast'));
    expect(result.origin).toBe('source');
  });
});

describe('createAssetResolver: source invocation limit', () => {
  it('stops invoking the source past the limit and serves the fallback instead', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = () => {
      calls++;
      return { data: new TextEncoder().encode(`img-${calls}`), contentType: 'image/png' };
    };
    const limits: number[] = [];
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('capped'),
      maxSourceInvocations: 2,
      onSourceLimit: (limit) => limits.push(limit),
    });

    expect((await resolver.resolve(req('k1'))).origin).toBe('source');
    expect((await resolver.resolve(req('k2'))).origin).toBe('source');

    // A third distinct key would be a third paid call: refused.
    const third = await resolver.resolve(req('k3'));
    expect(third.origin).toBe('fallback');
    expect(calls).toBe(2);
    expect(existsSync(join(dir, 'k3.png'))).toBe(false);

    // Announced once, not per refusal.
    await resolver.resolve(req('k4'));
    expect(limits).toEqual([2]);
  });

  it('still serves keys already cached once the limit is reached', async () => {
    const dir = tmp();
    const source: AssetSource = () => ({
      data: new TextEncoder().encode('generated'),
      contentType: 'image/png',
    });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('capped'),
      maxSourceInvocations: 1,
    });

    expect((await resolver.resolve(req('kept'))).origin).toBe('source');
    expect((await resolver.resolve(req('other'))).origin).toBe('fallback');
    // The cache read never reaches the limit check.
    expect((await resolver.resolve(req('kept'))).origin).toBe('cache');
  });

  it('does not spend budget on requests that join an in-flight generation', async () => {
    const dir = tmp();
    let calls = 0;
    let settle!: (r: { data: Uint8Array; contentType: string }) => void;
    const pending = new Promise<{ data: Uint8Array; contentType: string }>((r) => {
      settle = r;
    });
    const source: AssetSource = () => {
      calls++;
      return pending;
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('capped'),
      maxSourceInvocations: 1,
    });

    const a = resolver.resolve(req('shared'));
    const b = resolver.resolve(req('shared'));
    settle({ data: new TextEncoder().encode('bytes'), contentType: 'image/png' });
    for (const result of await Promise.all([a, b])) expect(result.origin).toBe('source');
    expect(calls).toBe(1);
  });
});

describe('createAssetResolver: source failure and retry', () => {
  it('a throwing source falls back, caches nothing, and is retried on the next resolve', async () => {
    const dir = tmp();
    let calls = 0;
    const source: AssetSource = () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { data: new TextEncoder().encode('recovered'), contentType: 'image/png' };
    };
    const resolver = createAssetResolver({ dir, source, fallback: () => fallbackBytes('throw') });

    const first = await resolver.resolve(req('k'));
    expect(first.origin).toBe('fallback');
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
    expect(calls).toBe(1);

    const second = await resolver.resolve(req('k'));
    expect(second.origin).toBe('source');
    expect(calls).toBe(2);
  });
});

describe('createAssetResolver: single-flight', () => {
  it('two concurrent resolves for the same key share one source invocation', async () => {
    const dir = tmp();
    let calls = 0;
    let settle!: (result: { data: Uint8Array; contentType: string }) => void;
    const pending = new Promise<{ data: Uint8Array; contentType: string }>((resolve) => {
      settle = resolve;
    });
    const source: AssetSource = () => {
      calls++;
      return pending;
    };
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    const p1 = resolver.resolve(req('shared'));
    const p2 = resolver.resolve(req('shared'));
    settle({ data: new TextEncoder().encode('shared-bytes'), contentType: 'image/png' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(r1.origin).toBe('source');
    expect(r2.origin).toBe('source');
    expect(Buffer.from(r1.data)).toEqual(Buffer.from(r2.data));

    // in-flight entry cleared on settle: a later resolve hits cache, not source
    const third = await resolver.resolve(req('shared'));
    expect(third.origin).toBe('cache');
    expect(calls).toBe(1);
  });
});

describe('createAssetResolver: corrupt cache entry', () => {
  it('falls through to source when the manifest-referenced file is missing on disk', async () => {
    const dir = tmp();
    // manifest claims a keyed file that was never written (simulated corruption)
    saveManifest(dir, { version: 1, images: [{ file: 'ghost.png', contentType: 'image/png', key: 'k' }] });
    let calls = 0;
    const source: AssetSource = () => {
      calls++;
      return { data: new TextEncoder().encode('rebuilt'), contentType: 'image/png' };
    };
    const resolver = createAssetResolver({ dir, source, fallback: failingFallback });

    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('source');
    expect(calls).toBe(1);
  });
});

describe('createAssetResolver: fallback only', () => {
  it('uses fallback when there is no cache entry, no source, and no pool', async () => {
    const dir = tmp();
    const resolver = createAssetResolver({ dir, fallback: () => fallbackBytes('empty') });
    const result = await resolver.resolve(req('k'));
    expect(result.origin).toBe('fallback');
  });
});

describe('createAssetResolver: materialisation signal', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const slowSource = (label: string): AssetSource => async () => {
    await sleep(20);
    return { data: new TextEncoder().encode(label), contentType: 'image/png' };
  };

  it('announces a key exactly once after its interim was superseded by the cached result', async () => {
    const dir = tmp();
    const announced: string[] = [];
    const resolver = createAssetResolver({
      dir,
      source: slowSource('portrait'),
      fallback: () => fallbackBytes('interim'),
      onMaterialised: (key) => announced.push(key),
    });

    expect((await resolver.resolve(req('slow'))).origin).toBe('interim');
    expect(announced).toEqual([]);

    await sleep(60);
    expect(announced).toEqual(['slow']);

    // The cached read that follows announces nothing more.
    expect((await resolver.resolve(req('slow'))).origin).toBe('cache');
    expect(announced).toEqual(['slow']);
  });

  it('announces a fetched { url } result the same way', async () => {
    const dir = tmp();
    const announced: string[] = [];
    const source: AssetSource = async () => {
      await sleep(20);
      return { url: 'https://example.test/face.png' };
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('interim'),
      fetchImpl: (async () =>
        fakeResponse({
          ok: true,
          status: 200,
          contentType: 'image/png',
          body: new TextEncoder().encode('fetched'),
        })) as unknown as typeof fetch,
      onMaterialised: (key) => announced.push(key),
    });

    expect((await resolver.resolve(req('remote'))).origin).toBe('interim');
    await sleep(60);
    expect(announced).toEqual(['remote']);
  });

  it('stays silent for a synchronous source, which never served a placeholder', async () => {
    const dir = tmp();
    const announced: string[] = [];
    const source: AssetSource = () => ({
      data: new TextEncoder().encode('quick'),
      contentType: 'image/png',
    });
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: failingFallback,
      onMaterialised: (key) => announced.push(key),
    });

    expect((await resolver.resolve(req('fast'))).origin).toBe('source');
    await sleep(20);
    expect(announced).toEqual([]);
  });

  it('stays silent when the source fails, because nothing superseded the placeholder', async () => {
    const dir = tmp();
    const announced: string[] = [];
    const source: AssetSource = async () => {
      await sleep(20);
      throw new Error('quota');
    };
    const resolver = createAssetResolver({
      dir,
      source,
      fallback: () => fallbackBytes('interim'),
      onMaterialised: (key) => announced.push(key),
    });

    expect((await resolver.resolve(req('broken'))).origin).toBe('interim');
    await sleep(60);
    expect(announced).toEqual([]);
  });

  it('a throwing callback does not break the resolve or the cache write', async () => {
    const dir = tmp();
    const resolver = createAssetResolver({
      dir,
      source: slowSource('portrait'),
      fallback: () => fallbackBytes('interim'),
      onMaterialised: () => {
        throw new Error('listener exploded');
      },
    });

    expect((await resolver.resolve(req('slow'))).origin).toBe('interim');
    await sleep(60);

    const second = await resolver.resolve(req('slow'));
    expect(second.origin).toBe('cache');
    expect(Buffer.from(second.data)).toEqual(Buffer.from(new TextEncoder().encode('portrait')));
  });
});
