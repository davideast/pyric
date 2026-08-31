import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeFingerprint,
  isCacheValid,
  saveSiteCache,
  restoreSiteCache,
  clearSiteCache,
  getCacheDir,
} from './cache.ts';

describe('site build cache', () => {
  let tmpDir: string;
  let cacheRoot: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pyric-site-cache-test-${Math.random().toString(36).slice(2)}`);
    cacheRoot = join(tmpDir, 'cache');
    mkdirSync(cacheRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fingerprint computation completes in under 2 seconds', () => {
    const start = performance.now();
    const key = computeFingerprint({ base: '/__pyric/ui/' });
    const duration = performance.now() - start;

    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(duration).toBeLessThan(2000);
  });

  test('fingerprint is deterministic for identical options', () => {
    const key1 = computeFingerprint({ base: '/__pyric/ui/' });
    const key2 = computeFingerprint({ base: '/__pyric/ui/' });
    expect(key1).toBe(key2);
  });

  test('changing base path changes fingerprint (no base path collisions)', () => {
    const keyUi = computeFingerprint({ base: '/__pyric/ui/' });
    const keyRoot = computeFingerprint({ base: '/' });
    expect(keyUi).not.toBe(keyRoot);
  });

  test('changing studioStatic changes fingerprint', () => {
    const key1 = computeFingerprint({ base: '/', studioStatic: false });
    const key2 = computeFingerprint({ base: '/', studioStatic: true });
    expect(key1).not.toBe(key2);
  });

  test('saveSiteCache and restoreSiteCache round-trip build artifacts', () => {
    const key = 'test-key-12345';
    const sourceDir = join(tmpDir, 'source-dist');
    const targetDir = join(tmpDir, 'target-dist');

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'index.html'), '<html>Site</html>');
    mkdirSync(join(sourceDir, 'assets'), { recursive: true });
    writeFileSync(join(sourceDir, 'assets', 'style.css'), 'body { color: red; }');

    expect(isCacheValid(key, cacheRoot)).toBe(false);

    saveSiteCache(key, sourceDir, cacheRoot);
    expect(isCacheValid(key, cacheRoot)).toBe(true);

    const restored = restoreSiteCache(key, targetDir, cacheRoot);
    expect(restored).toBe(true);
    expect(existsSync(join(targetDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe('<html>Site</html>');
    expect(readFileSync(join(targetDir, 'assets', 'style.css'), 'utf8')).toBe('body { color: red; }');
  });

  test('clearSiteCache invalidates cached fingerprints', () => {
    const key = 'test-key-67890';
    const sourceDir = join(tmpDir, 'source-dist');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'index.html'), '<html>Site</html>');

    saveSiteCache(key, sourceDir, cacheRoot);
    expect(isCacheValid(key, cacheRoot)).toBe(true);

    clearSiteCache(cacheRoot);
    expect(isCacheValid(key, cacheRoot)).toBe(false);
    expect(existsSync(getCacheDir(key, cacheRoot))).toBe(false);
  });
});
