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
