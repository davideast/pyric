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
  appFirebaseRoot,
  firebaseAppCopies,
  installedFirebaseVersion,
  isSupportedFirebaseVersion,
  liveStartRefusal,
  resolutionRoots,
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

  test('names the copy @firebase/database resolves from outside the project tree', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    const outside = project();
    const database = installPackage(join(outside, 'node_modules/@firebase/database'), '@firebase/database', '1.0.0');
    const outsideApp = installPackage(join(outside, 'node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    symlinkSync(database, join(root, 'node_modules/@firebase/database'));
    expect(firebaseAppCopies(root)).toEqual([join(root, 'node_modules/@firebase/app'), outsideApp].sort());
    expect(liveStartRefusal(root)).toContain('This project has 2 copies of @firebase/app installed:');
  });
});

describe('the copies of @firebase/app in a workspace', () => {
  /** A workspace root with the app at `packages/app`, as npm, yarn and bun lay one out. */
  function workspace(): { root: string; app: string } {
    const root = project();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }));
    const app = join(root, 'packages/app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    return { root, app };
  }

  test('finds a second copy nested under a package hoisted to the workspace root', () => {
    const { root, app } = workspace();
    installFirebase(root, '12.19.0');
    const nested = installPackage(join(root, 'node_modules/reactfire/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    expect(firebaseAppCopies(app)).toEqual([join(root, 'node_modules/@firebase/app'), nested]);
    expect(liveStartRefusal(app)).toContain('This project has 2 copies of @firebase/app installed:');
  });

  test('finds a copy in the app folder beside the hoisted one', () => {
    const { root, app } = workspace();
    installFirebase(root, '12.19.0');
    const local = installPackage(join(app, 'node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    expect(firebaseAppCopies(app)).toEqual([join(root, 'node_modules/@firebase/app'), local].sort());
  });

  test('finds every copy in the root pnpm store of a pnpm workspace', () => {
    const root = project();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const app = join(root, 'packages/app');
    mkdirSync(app, { recursive: true });
    const first = installPackage(join(root, 'node_modules/.pnpm/@firebase+app@0.14.0/node_modules/@firebase/app'), '@firebase/app', '0.14.0');
    const second = installPackage(join(root, 'node_modules/.pnpm/@firebase+app@0.13.2/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    installPackage(join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/firebase'), 'firebase', '12.19.0');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    symlinkSync(join(root, 'node_modules/.pnpm/firebase@12.19.0/node_modules/firebase'), join(app, 'node_modules/firebase'));
    expect(firebaseAppCopies(app)).toEqual([first, second].sort());
  });

  test('a single hoisted copy passes', () => {
    const { root, app } = workspace();
    installFirebase(root, '12.19.0');
    expect(liveStartRefusal(app)).toBeNull();
  });

  test('finds a copy in a parent folder that declares no workspaces, as Node resolves one', () => {
    const outer = project();
    mkdirSync(join(outer, '.git'));
    const stray = installPackage(join(outer, 'node_modules/stray/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    const app = join(outer, 'apps/app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    installFirebase(app, '12.19.0');
    expect(resolutionRoots(app)).toEqual([app, join(outer, 'apps'), outer]);
    expect(firebaseAppCopies(app)).toEqual([join(app, 'node_modules/@firebase/app'), stray].sort());
    expect(liveStartRefusal(app)).toContain('This project has 2 copies of @firebase/app installed:');
  });

  test('stops at the first folder above the project that holds .git', () => {
    const outer = project();
    installPackage(join(outer, 'node_modules/stray/node_modules/@firebase/app'), '@firebase/app', '0.13.2');
    const repository = join(outer, 'repository');
    mkdirSync(repository, { recursive: true });
    // A worktree's .git is a file.
    writeFileSync(join(repository, '.git'), 'gitdir: /elsewhere\n');
    const app = join(repository, 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    installFirebase(app, '12.19.0');
    expect(resolutionRoots(app)).toEqual([app, repository]);
    expect(firebaseAppCopies(app)).toEqual([join(app, 'node_modules/@firebase/app')]);
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
    expect(refusal).not.toContain('\u2014');
  });
});

describe('the folder the app loads firebase from', () => {
  test('is the app folder when firebase is installed only there, below the project root (#2161)', () => {
    const root = project();
    const web = join(root, 'web');
    installFirebase(web, '12.19.0');
    expect(appFirebaseRoot(web, root)).toBe(web);
    expect(liveStartRefusal(root)).toContain('This project has no firebase installed.');
    expect(liveStartRefusal(root, web)).toBeNull();
  });

  test('is the app folder when it resolves the hoisted firebase above it', () => {
    const root = project();
    installFirebase(root, '12.19.0');
    expect(appFirebaseRoot(join(root, 'web'), root)).toBe(join(root, 'web'));
    expect(liveStartRefusal(root, join(root, 'web'))).toBeNull();
  });

  test('is the project root when the app folder resolves no firebase', () => {
    const root = project();
    const elsewhere = project();
    installFirebase(root, '12.19.0');
    expect(appFirebaseRoot(elsewhere, root)).toBe(root);
    expect(liveStartRefusal(root, elsewhere)).toBeNull();
  });

  test('checks the version of the copy the app folder resolves, before the project root\'s', () => {
    const root = project();
    const web = join(root, 'web');
    installFirebase(root, '12.19.0');
    installFirebase(web, '11.10.0');
    expect(liveStartRefusal(root, web)).toContain('This project has firebase 11.10.0 installed.');
  });
});
