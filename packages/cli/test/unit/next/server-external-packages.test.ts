import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { augmentServerExternalPackages } from '../../../src/next/server-external-packages.js';

/** The `serverExternalPackages` withPyric gives an empty config for a project in `projectDir`. */
function firebaseServerExternals(projectDir: string): readonly string[] | undefined {
  return augmentServerExternalPackages({}, projectDir).serverExternalPackages;
}

describe('Next server externals (#1626)', () => {
  let root: string;

  function writeJson(relative: string, value: unknown): void {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, JSON.stringify(value));
  }

  function install(folder: string, name: string): void {
    writeJson(`node_modules/${folder}/package.json`, { name, version: '1.0.0' });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-next-externals-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps firebase and firebase-admin external with nothing installed', () => {
    expect(firebaseServerExternals(root)).toEqual(['firebase-admin', 'firebase']);
  });

  it('keeps an npm-aliased firebase-admin external by the name the app imports', () => {
    writeJson('package.json', { dependencies: { 'admin-alias': 'npm:firebase-admin@13', next: '16.4.3' } });
    install('admin-alias', 'firebase-admin');
    install('next', 'next');
    expect(firebaseServerExternals(root)).toEqual(['firebase-admin', 'firebase', 'admin-alias']);
  });

  it('keeps aliases of firebase and of a @firebase package external, from every dependency field', () => {
    writeJson('package.json', {
      devDependencies: { 'client-alias': 'npm:firebase@12' },
      optionalDependencies: { 'store-alias': 'npm:@firebase/firestore@4' },
    });
    install('client-alias', 'firebase');
    install('store-alias', '@firebase/firestore');
    expect(firebaseServerExternals(root)).toEqual(['firebase-admin', 'firebase', 'client-alias', 'store-alias']);
  });

  it('leaves out a dependency whose installed name is not a Firebase SDK, or that is not installed', () => {
    writeJson('package.json', { dependencies: { 'firebase-tools-like': '1.0.0', missing: '1.0.0' } });
    install('firebase-tools-like', 'firebase-tools');
    expect(firebaseServerExternals(root)).toEqual(['firebase-admin', 'firebase']);
  });

  it('keeps every installed @firebase package external, including those in a parent node_modules', () => {
    const project = join(root, 'apps', 'web');
    mkdirSync(project, { recursive: true });
    writeJson('apps/web/node_modules/@firebase/firestore/package.json', { name: '@firebase/firestore' });
    install('@firebase/app', '@firebase/app');
    expect([...(firebaseServerExternals(project) ?? [])].sort()).toEqual(
      ['@firebase/app', '@firebase/firestore', 'firebase', 'firebase-admin'],
    );
  });

  it('finds a hoisted alias from a workspace package', () => {
    const project = join(root, 'apps', 'web');
    writeJson('apps/web/package.json', { dependencies: { admin: 'npm:firebase-admin@13' } });
    install('admin', 'firebase-admin');
    expect(firebaseServerExternals(project)).toEqual(['firebase-admin', 'firebase', 'admin']);
  });

  it('adds the aliases and the scope to both external lists, after the existing entries', () => {
    writeJson('package.json', { dependencies: { 'admin-alias': 'npm:firebase-admin@13' } });
    install('admin-alias', 'firebase-admin');
    install('@firebase/app', '@firebase/app');
    const config = augmentServerExternalPackages(
      { serverExternalPackages: ['existing-pkg'], experimental: { serverComponentsExternalPackages: ['firebase'] } },
      root,
    );
    expect(config.serverExternalPackages).toEqual(['existing-pkg', 'firebase-admin', 'firebase', 'admin-alias', '@firebase/app']);
    expect(config.experimental?.serverComponentsExternalPackages).toEqual(
      ['firebase', 'firebase-admin', 'admin-alias', '@firebase/app'],
    );
  });
});
