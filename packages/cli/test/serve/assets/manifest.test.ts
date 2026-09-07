import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetManifestError,
  loadManifest,
  saveManifest,
  type AssetManifest,
} from '../../../src/serve/assets/manifest.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pyric-assets-manifest-'));

describe('loadManifest / saveManifest', () => {
  it('returns null when manifest.json is absent', () => {
    expect(loadManifest(tmp())).toBeNull();
  });

  it('round-trips a manifest atomically, creating the directory recursively', () => {
    const dir = join(tmp(), 'nested', 'assets');
    const manifest: AssetManifest = {
      version: 1,
      name: 'avatars',
      images: [
        { file: 'a.png', contentType: 'image/png' },
        { file: 'b.png', contentType: 'image/png', key: 'user-1' },
      ],
    };
    saveManifest(dir, manifest);
    expect(loadManifest(dir)).toEqual(manifest);
    // no tmp residue left behind
    expect(readdirSync(dir).sort()).toEqual(['manifest.json']);
  });

  it('fails closed on an unknown manifest version', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 2, images: [] }));
    expect(() => loadManifest(dir)).toThrow(AssetManifestError);
    expect(() => loadManifest(dir)).toThrow(/version/);
  });

  it('rejects an image file entry containing a path separator', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, images: [{ file: '../escape.png' }] }),
    );
    expect(() => loadManifest(dir)).toThrow(AssetManifestError);

    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ version: 1, images: [{ file: 'sub/dir.png' }] }),
    );
    expect(() => loadManifest(dir)).toThrow(/path separators/);
  });

  it('rejects malformed shapes', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1 }));
    expect(() => loadManifest(dir)).toThrow(/"images" must be an array/);

    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    expect(() => loadManifest(dir)).toThrow(/not valid JSON/);

    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([1, 2, 3]));
    expect(() => loadManifest(dir)).toThrow(/not an object/);
  });

  it('mkdirs recursively and is safe to call again on an existing directory', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    saveManifest(dir, { version: 1, images: [] });
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });
});
