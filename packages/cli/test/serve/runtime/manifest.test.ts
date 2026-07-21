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
        expect(selector).toBe('meta[name="pyric-worker-v"]');
        return { getAttribute: (name: string) => name === 'content' ? 'epoch-123' : null };
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
});
