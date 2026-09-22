import { describe, expect, it } from 'bun:test';
import {
  PYRIC_STUDIO_URL,
  PYRIC_WORKER_NAME,
  PYRIC_WORKER_URL,
  readPyricRuntimeManifest,
} from '../../../src/serve/runtime/manifest.js';

describe('Pyric runtime manifest', () => {
  it('describes the served worker epoch and stable runtime routes', () => {
    const documentLike = {
      querySelector(selector: string) {
        if (selector === 'meta[name="pyric-worker-v"]') {
          return { getAttribute: (name: string) => name === 'content' ? 'epoch-123' : null };
        }
        return null;
      },
    };

    expect(readPyricRuntimeManifest(documentLike)).toEqual({
      studioUrl: PYRIC_STUDIO_URL,
      worker: {
        url: PYRIC_WORKER_URL,
        name: PYRIC_WORKER_NAME,
        servedEpoch: 'epoch-123',
      },
    });
  });

  it('reports no served epoch on the in-page fallback', () => {
    expect(readPyricRuntimeManifest({ querySelector: () => null }).worker.servedEpoch).toBeNull();
  });

  it('resolves studioUrl from NEXT_PUBLIC_PYRIC_STUDIO_URL if set', () => {
    process.env.NEXT_PUBLIC_PYRIC_STUDIO_URL = 'http://localhost:3473/__pyric/ui/studio';
    try {
      expect(readPyricRuntimeManifest({ querySelector: () => null }).studioUrl)
        .toBe('http://localhost:3473/__pyric/ui/studio');
    } finally {
      delete process.env.NEXT_PUBLIC_PYRIC_STUDIO_URL;
    }
  });

  it('resolves studioUrl from __PYRIC_WORKER_INIT__.studioUrl', () => {
    (globalThis as any).__PYRIC_WORKER_INIT__ = {
      hosted: true,
      studioUrl: 'http://localhost:3473/__pyric/ui/studio',
    };
    try {
      expect(readPyricRuntimeManifest({ querySelector: () => null }).studioUrl)
        .toBe('http://localhost:3473/__pyric/ui/studio');
    } finally {
      delete (globalThis as any).__PYRIC_WORKER_INIT__;
    }
  });

  it('derives studioUrl from __PYRIC_WORKER_INIT__.bridgeUrl when host port differs from page location', () => {
    (globalThis as any).__PYRIC_WORKER_INIT__ = {
      hosted: true,
      bridgeUrl: 'ws://localhost:3473/__pyric/sandbox',
    };
    try {
      expect(readPyricRuntimeManifest({ querySelector: () => null }, { href: 'http://localhost:3000/app', host: 'localhost:3000' }).studioUrl)
        .toBe('http://localhost:3473/__pyric/ui/studio');
    } finally {
      delete (globalThis as any).__PYRIC_WORKER_INIT__;
    }
  });

  it('resolves studioUrl from meta[name="pyric-studio-url"] tag', () => {
    const doc = {
      querySelector(selector: string) {
        if (selector === 'meta[name="pyric-studio-url"]') {
          return { getAttribute: (attr: string) => attr === 'content' ? 'http://127.0.0.1:3473/__pyric/ui/studio' : null };
        }
        return null;
      },
    };
    expect(readPyricRuntimeManifest(doc).studioUrl).toBe('http://127.0.0.1:3473/__pyric/ui/studio');
  });
});
