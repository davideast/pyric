import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAvatarsConfig } from '../../src/serve/avatars-config.js';
import { saveManifest } from '../../src/serve/assets/manifest.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-avatars-config-'));
}

describe('resolveAvatarsConfig', () => {
  it('zero-config: enabled, no set directory or source', () => {
    const root = project();
    expect(resolveAvatarsConfig(undefined, {}, root)).toEqual({ enabled: true });
  });

  it('false disables the route entirely', () => {
    const root = project();
    expect(resolveAvatarsConfig(false, {}, root)).toEqual({ enabled: false });
  });

  it('a string option resolves and validates a set directory against the project root', () => {
    const root = project();
    const setDir = join(root, 'avatars', 'anime');
    mkdirSync(setDir, { recursive: true });
    saveManifest(setDir, { version: 1, images: [{ file: '001.png' }] });

    expect(resolveAvatarsConfig('avatars/anime', {}, root)).toEqual({
      enabled: true,
      setDir,
    });
  });

  it('an object option carries the source through untouched', () => {
    const root = project();
    const source = async () => ({ data: new Uint8Array(), contentType: 'image/png' });
    expect(resolveAvatarsConfig({ source }, {}, root)).toEqual({
      enabled: true,
      source,
    });
  });

  it('an explicit option wins over PYRIC_AVATARS', () => {
    const root = project();
    expect(resolveAvatarsConfig(false, { PYRIC_AVATARS: 'avatars/anime' }, root)).toEqual({
      enabled: false,
    });
  });

  it('PYRIC_AVATARS=0 and PYRIC_AVATARS=false disable the route', () => {
    const root = project();
    expect(resolveAvatarsConfig(undefined, { PYRIC_AVATARS: '0' }, root)).toEqual({ enabled: false });
    expect(resolveAvatarsConfig(undefined, { PYRIC_AVATARS: 'false' }, root)).toEqual({ enabled: false });
  });

  it('any other non-empty PYRIC_AVATARS value names a set directory', () => {
    const root = project();
    const setDir = join(root, 'sets', 'pixel');
    mkdirSync(setDir, { recursive: true });
    saveManifest(setDir, { version: 1, images: [{ file: 'a.png' }] });

    expect(resolveAvatarsConfig(undefined, { PYRIC_AVATARS: 'sets/pixel' }, root)).toEqual({
      enabled: true,
      setDir,
    });
  });

  it('throws a config-time error when the set directory does not exist', () => {
    const root = project();
    expect(() => resolveAvatarsConfig('does/not/exist', {}, root)).toThrow(
      /avatars set directory not found/,
    );
  });

  it('throws a config-time error when the set directory has no manifest.json', () => {
    const root = project();
    const setDir = join(root, 'no-manifest');
    mkdirSync(setDir, { recursive: true });
    expect(() => resolveAvatarsConfig('no-manifest', {}, root)).toThrow(/has no manifest\.json/);
  });

  it('throws a config-time error when the manifest is malformed', () => {
    const root = project();
    const setDir = join(root, 'bad-manifest');
    mkdirSync(setDir, { recursive: true });
    writeFileSync(join(setDir, 'manifest.json'), '{ not json');
    expect(() => resolveAvatarsConfig('bad-manifest', {}, root)).toThrow(
      /invalid manifest\.json/,
    );
  });

  it('validates a set directory named by PYRIC_AVATARS the same way', () => {
    const root = project();
    expect(() =>
      resolveAvatarsConfig(undefined, { PYRIC_AVATARS: 'nope' }, root),
    ).toThrow(/avatars set directory not found/);
  });
});
