import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextConfigObject } from '../../../src/next/types.js';
import {
  augmentServerExternalPackages,
  projectDirWarning,
} from '../../../src/next/server-external-packages.js';

describe('Next server externals (#1626)', () => {
  let root: string;

  function writeJson(relative: string, value: unknown): void {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, JSON.stringify(value));
  }

  /** Installs a package named `name` in the folder `node_modules/<folder>` under `base`. */
  function install(folder: string, name: string, base = ''): void {
    writeJson(join(base, 'node_modules', folder, 'package.json'), { name, version: '1.0.0' });
  }

  /** Runs withPyric's augmentation for a project in `projectDir`, searching no folder above `root`. */
  function augment(config: NextConfigObject, projectDir = root): NextConfigObject {
    return augmentServerExternalPackages(config, { projectDir, stopDir: root });
  }

  function externals(projectDir = root): readonly string[] {
    return augment({}, projectDir).serverExternalPackages as string[];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-next-externals-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps firebase and firebase-admin external with nothing installed', () => {
    expect(externals()).toEqual(['firebase-admin', 'firebase']);
  });

  it('keeps an npm-aliased firebase-admin external by the name it is installed under', () => {
    install('admin-alias', 'firebase-admin');
    install('next', 'next');
    expect(externals()).toEqual(['firebase-admin', 'firebase', 'admin-alias']);
  });

  it('keeps aliases of firebase and of a @firebase package external, scoped or not', () => {
    install('client-alias', 'firebase');
    install('@acme/store', '@firebase/firestore');
    expect(externals()).toEqual(['firebase-admin', 'firebase', '@acme/store', 'client-alias']);
  });

  it('leaves out a package whose own name is not a Firebase SDK, and a folder with no manifest', () => {
    install('firebase-tools-like', 'firebase-tools');
    mkdirSync(join(root, 'node_modules', 'empty'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    expect(externals()).toEqual(['firebase-admin', 'firebase']);
  });

  it('keeps every installed @firebase package external, in the project and in parent node_modules', () => {
    const project = join(root, 'apps', 'web');
    install('@firebase/firestore', '@firebase/firestore', 'apps/web');
    install('@firebase/app', '@firebase/app');
    expect([...externals(project)].sort()).toEqual(
      ['@firebase/app', '@firebase/firestore', 'firebase', 'firebase-admin'],
    );
  });

  it('keeps an alias external that only a hoisted workspace package declares', () => {
    const project = join(root, 'apps', 'web');
    writeJson('apps/web/package.json', { dependencies: { '@acme/server-utils': 'workspace:*' } });
    writeJson('packages/server-utils/package.json', {
      name: '@acme/server-utils',
      dependencies: { admin: 'npm:firebase-admin@13' },
    });
    install('admin', 'firebase-admin');
    expect(externals(project)).toEqual(['firebase-admin', 'firebase', 'admin']);
  });

  it('searches no folder above the stop directory', () => {
    const project = join(root, 'apps', 'web');
    install('admin', 'firebase-admin');
    const config = augmentServerExternalPackages({}, { projectDir: project, stopDir: project });
    expect(config.serverExternalPackages).toEqual(['firebase-admin', 'firebase']);
  });

  it('adds the aliases and the scope to both external lists, after the existing entries', () => {
    install('admin-alias', 'firebase-admin');
    install('@firebase/app', '@firebase/app');
    const config = augment({
      serverExternalPackages: ['existing-pkg'],
      experimental: { serverComponentsExternalPackages: ['firebase'] },
    });
    expect(config.serverExternalPackages).toEqual(['existing-pkg', 'firebase-admin', 'firebase', '@firebase/app', 'admin-alias']);
    expect(config.experimental?.serverComponentsExternalPackages).toEqual(
      ['firebase', 'firebase-admin', '@firebase/app', 'admin-alias'],
    );
  });

  it('refuses transpilePackages that list a package it keeps external, naming the package', () => {
    install('admin-alias', 'firebase-admin');
    install('@firebase/firestore', '@firebase/firestore');
    const transpiling = { transpilePackages: ['ui-kit', '@firebase/firestore', 'admin-alias'] };
    expect(() => augment(transpiling)).toThrow(
      "@pyric/cli/next: transpilePackages lists '@firebase/firestore', 'admin-alias', a Firebase SDK withPyric keeps out of server bundles.",
    );
    expect(augment({ transpilePackages: ['ui-kit'] }).transpilePackages).toEqual(['ui-kit']);
  });
});

describe('Next project directory warning (#1626)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-next-project-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns when the directory has no next.config file', () => {
    expect(projectDirWarning(root)).toContain(`@pyric/cli/next: no next.config file in ${root}`);
  });

  it('stays quiet for each next.config file Next loads', () => {
    for (const file of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts', 'next.config.cts']) {
      const project = join(root, file.replace(/\./g, '-'));
      mkdirSync(project);
      writeFileSync(join(project, file), 'export default {};\n');
      expect(projectDirWarning(project)).toBeNull();
    }
  });
});
