/** `GET /__pyric/assets/avatar/<uid>`, mounted in the `/__pyric/` namespace. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarSeed } from 'pyric/auth/internal';
import { avatarUidFromPath } from '../../../src/serve/assets/avatar-route.js';
import { createPyricNamespace } from '../../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../../src/serve/server.js';
import type {
  AssetOrigin,
  AssetRequest,
  AssetResolver,
  ResolvedAsset,
} from '../../../src/serve/assets/resolver.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-avatar-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  return { site, sdk };
}

const AVATAR_BYTES = new TextEncoder().encode('avatar-bytes');

/** A resolver that records what the route asked for and answers with fixed
 *  bytes at the requested origin. */
function spyResolver(origin: AssetOrigin = 'cache'): AssetResolver & { requests: AssetRequest[] } {
  const requests: AssetRequest[] = [];
  return {
    requests,
    async resolve(req: AssetRequest): Promise<ResolvedAsset> {
      requests.push(req);
      return { data: AVATAR_BYTES, contentType: 'image/png', origin };
    },
  };
}

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

async function serve(avatars?: AssetResolver): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const namespaceOptions = {
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    ...(avatars ? { avatars } : {}),
  };
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger: silentServeLogger(),
    namespaceHandler: createPyricNamespace(namespaceOptions),
  });
  handles.push(h);
  return h;
}

describe('avatar route: mounting', () => {
  it('404s the whole assets prefix when no resolver is configured', async () => {
    const h = await serve();

    expect((await fetch(`${h.url}/__pyric/assets/avatar/alice`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/other/x`)).status).toBe(404);
  });

  it('404s an unknown consumer segment even when a resolver is configured', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    expect((await fetch(`${h.url}/__pyric/assets/other/x`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/alice/extra`)).status).toBe(404);
    expect(resolver.requests).toEqual([]);
  });
});

describe('avatar route: serving', () => {
  it('serves the resolved bytes and content type', async () => {
    const h = await serve(spyResolver());

    const response = await fetch(`${h.url}/__pyric/assets/avatar/alice`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(AVATAR_BYTES));
  });

  it('seeds from avatarSeed(uid) when no `d` is supplied, and honours `d` when it is', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    await fetch(`${h.url}/__pyric/assets/avatar/alice`);
    await fetch(`${h.url}/__pyric/assets/avatar/alice?d=fixed-seed`);

    expect(resolver.requests[0]!.seed).toBe(avatarSeed('alice'));
    expect(resolver.requests[1]!.seed).toBe('fixed-seed');
  });

  it('carries the uid and the query hints in the request context', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    await fetch(
      `${h.url}/__pyric/assets/avatar/alice?n=${encodeURIComponent('Ada Lovelace')}` +
        `&e=${encodeURIComponent('ada@example.com')}&p=google.com`,
    );
    await fetch(`${h.url}/__pyric/assets/avatar/bob`);

    expect(resolver.requests[0]).toEqual({
      key: 'alice',
      seed: avatarSeed('alice'),
      context: {
        uid: 'alice',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        providerId: 'google.com',
      },
    });
    expect(resolver.requests[1]!.context).toEqual({
      uid: 'bob',
      displayName: null,
      email: null,
      providerId: null,
    });
  });

  it('405s a non-GET method without consulting the resolver', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    const response = await fetch(`${h.url}/__pyric/assets/avatar/alice`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(resolver.requests).toEqual([]);
  });
});

describe('avatarUidFromPath', () => {
  it('accepts exactly one segment under the avatar prefix', () => {
    expect(avatarUidFromPath('/__pyric/assets/avatar/alice')).toBe('alice');
    expect(avatarUidFromPath('/__pyric/assets/avatar/alice%40example.com')).toBe('alice@example.com');
    expect(avatarUidFromPath('/__pyric/assets/avatar/')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/avatar/alice/extra')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/other/alice')).toBeNull();
    expect(avatarUidFromPath('/__pyric/sdk/auth.js')).toBeNull();
  });

  it('rejects a segment that decodes to a path fragment or malformed encoding', () => {
    expect(avatarUidFromPath('/__pyric/assets/avatar/%2E')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/avatar/%2E%2E')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/avatar/%2F')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/avatar/a%5Cb')).toBeNull();
    expect(avatarUidFromPath('/__pyric/assets/avatar/%ZZ')).toBeNull();
  });
});

describe('avatar route: uid validation', () => {
  it('rejects a uid that decodes to a path fragment', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    // `..` and `.` percent-encoded so the URL parser does not collapse them
    // before the request leaves.
    expect((await fetch(`${h.url}/__pyric/assets/avatar/%2E%2E`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/%2E`)).status).toBe(404);
    // Encoded slash and backslash: a uid becomes a cache filename.
    expect((await fetch(`${h.url}/__pyric/assets/avatar/%2F`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/a%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/a%5Cb`)).status).toBe(404);
    expect(resolver.requests).toEqual([]);
  });

  it('rejects a uid longer than 256 characters', async () => {
    const resolver = spyResolver();
    const h = await serve(resolver);

    expect((await fetch(`${h.url}/__pyric/assets/avatar/${'u'.repeat(256)}`)).status).toBe(200);
    expect((await fetch(`${h.url}/__pyric/assets/avatar/${'u'.repeat(257)}`)).status).toBe(404);
    expect(resolver.requests).toHaveLength(1);
  });
});

describe('avatar route: caching semantics', () => {
  it('caches a materialised origin for an hour', async () => {
    const h = await serve(spyResolver('cache'));

    const response = await fetch(`${h.url}/__pyric/assets/avatar/alice`);

    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('never caches the generated fallback, so the next fetch retries', async () => {
    const h = await serve(spyResolver('fallback'));

    const response = await fetch(`${h.url}/__pyric/assets/avatar/alice`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('avatar route: failure containment', () => {
  it('500s a throwing resolver instead of crashing the dev server', async () => {
    const throwing: AssetResolver = {
      resolve: async () => {
        throw new Error('resolver exploded');
      },
    };
    const h = await serve(throwing);

    const response = await fetch(`${h.url}/__pyric/assets/avatar/alice`);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('avatar resolution failed');
  });
});
