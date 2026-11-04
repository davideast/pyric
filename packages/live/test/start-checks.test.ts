/**
 * The checks every live mode start runs: the app's installed `firebase` is in
 * the supported range, and one copy of `@firebase/app` is installed. Each
 * project here is a folder of package.json files laid out as a package
 * manager lays them out; nothing is installed or loaded.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUPPORTED_FIREBASE_RANGE,
  firebaseAppCopies,
  installedFirebaseVersion,
  isSupportedFirebaseVersion,
  liveStartRefusal,
} from '../src/start-checks.js';

const roots: string[] = [];

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-checks-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true }));
  return root;
}

function installPackage(dir: string, name: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, exports: { './package.json': './package.json' } }));
  return dir;
}

/** firebase with its own `@firebase/app`, hoisted beside it as npm installs it. */
function installFirebase(root: string, version: string): void {
  installPackage(join(root, 'node_modules/firebase'), 'firebase', version);
  installPackage(join(root, 'node_modules/@firebase/app'), '@firebase/app', '0.14.0');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the supported firebase range', () => {
  test(`is ${SUPPORTED_FIREBASE_RANGE}: 12.12.0 up to, not including, 13`, () => {
    expect(SUPPORTED_FIREBASE_RANGE).toBe('^12.12.0');
    for (const version of ['12.12.0', '12.12.1', '12.19.0', '12.100.3']) expect(isSupportedFirebaseVersion(version), version).toBe(true);
    for (const version of ['12.11.9', '11.10.0', '13.0.0', '12.12.0-beta.1', '12', 'latest', '']) expect(isSupportedFirebaseVersion(version), version).toBe(false);
  });
});

describe('the installed firebase version', () => {
  test('is read from the firebase the project root resolves', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    expect(installedFirebaseVersion(root)).toBe('12.19.0');
  });

  test('is null when the project has no firebase', () => {
    expect(installedFirebaseVersion(project())).toBeNull();
  });
});

describe('the installed copies of @firebase/app', () => {
  test('is one for a hoisted install', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    expect(firebaseAppCopies(root)).toEqual([join(root, 'node_modules/@firebase/app')]);
  });

  test('names a copy nested under another package', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    const nested = installPackage(join(root, 'node_modules/reactfire/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    expect(firebaseAppCopies(root)).toEqual([join(root, 'node_modules/@firebase/app'), nested]);
  });

  test('names a copy in a pnpm store once, however many links point at it', () => {
    const root = project();
    const store = installPackage(join(root, 'node_modules/.pnpm/@firebase+app@0.14.0/node_modules/@firebase/app'), '@firebase/app', '0.14.0');
    installPackage(join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/firebase'), 'firebase', '12.19.0');
    mkdirSync(join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/@firebase'), { recursive: true });
    symlinkSync(store, join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/@firebase/app'));
    symlinkSync(join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/firebase'), join(root, 'node_modules/firebase'));
    expect(firebaseAppCopies(root)).toEqual([store]);
  });
});

describe('the start refusal', () => {
  test('is null for a supported firebase with one @firebase/app', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    expect(liveStartRefusal(root)).toBeNull();
  });

  test('names the found version when firebase is outside the range', () => {
    const root = project();
    installFirebase(root, '11.10.0');
    const refusal = liveStartRefusal(root);
    expect(refusal).toContain('Live mode did not start.');
    expect(refusal).toContain('needs firebase ^12.12.0');
    expect(refusal).toContain('This project has firebase 11.10.0 installed.');
    expect(refusal).toContain('npm install firebase@^12.12.0');
  });

  test('says firebase is not installed when the project has none', () => {
    const refusal = liveStartRefusal(project());
    expect(refusal).toContain('This project has no firebase installed.');
  });

  test('names the path of every copy when more than one @firebase/app is installed', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    const nested = installPackage(join(root, 'node_modules/reactfire/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    const refusal = liveStartRefusal(root) ?? '';
    expect(refusal).toContain('Live mode did not start.');
    expect(refusal).toContain('This project has 2 copies of @firebase/app installed:');
    expect(refusal).toContain(join(root, 'node_modules/@firebase/app'));
    expect(refusal).toContain(nested);
    expect(refusal).toContain('npm dedupe');
    expect(refusal).not.toContain('—');
  });
});
