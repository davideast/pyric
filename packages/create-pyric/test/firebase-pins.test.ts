/**
 * The scaffold pins stay on the certified Firebase lines (#1188). `firebase`
 * must be a patch range on FIREBASE_TESTED_AGAINST, and `firebase-admin` a
 * patch range on the installed firebase-admin, the version
 * `compat:oracle-versions` checks the observations against. The chat
 * template's package.json files are static assets, so this test holds them to
 * the same pins.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../scripts/lib/private-job-tmpdir.ts';
import { FIREBASE_TESTED_AGAINST } from '../../cli/src/version/compat-target.ts';
import { resolvedAdminVersion } from '../../conformance/src/package-version.ts';
import { FIREBASE_ADMIN_PIN, FIREBASE_PIN } from '../src/firebase-pins.ts';
import { TEMPLATES, TEMPLATE_NAMES } from '../src/templates.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const CREATE_PYRIC_DIR = resolve(import.meta.dir, '..');
const TEMPLATES_DIR = join(CREATE_PYRIC_DIR, 'templates');
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    removePrivateJobTmpDir(dir);
  }
});

function installedAdminVersion(): string {
  return resolvedAdminVersion();
}

function readTemplate(path: string): string {
  return readFileSync(join(TEMPLATES_DIR, path), 'utf8');
}

function readManifest(path: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readTemplate(path)) as Record<string, Record<string, string> | undefined>;
}

/** The lowest version a `~x.y.z` or `^x.y.z` pin allows, as [major, minor, patch]. */
function pinFloor(pin: string): [number, number, number] {
  const match = /^[~^]?(\d+)\.(\d+)\.(\d+)$/.exec(pin);
  if (match === null) {
    throw new Error(`Cannot read the lowest version of the pin ${pin}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(version: [number, number, number], floor: [number, number, number]): boolean {
  for (let index = 0; index < floor.length; index++) {
    if (version[index] !== floor[index]) {
      return version[index] > floor[index];
    }
  }
  return true;
}

/**
 * `getAI(app, { useLimitedUseAppCheckTokens: true })` needs firebase 12.14.0
 * or later (https://firebase.google.com/docs/ai-logic/app-check), so the pin
 * must not allow an earlier version while the chat template asks for them (#1397).
 */
const LIMITED_USE_TOKENS_FLOOR: [number, number, number] = [12, 14, 0];
const CHAT_FIREBASE_APP = 'chat/src/firebase/app.ts';

describe('scaffold Firebase pins', () => {
  test('firebase is a patch range on the certified version', () => {
    expect(FIREBASE_PIN).toBe(`~${FIREBASE_TESTED_AGAINST}`);
  });

  test('firebase-admin is a patch range on the version the observations were captured against', () => {
    expect(FIREBASE_ADMIN_PIN).toBe(`~${installedAdminVersion()}`);
  });

  test('every template that names firebase or firebase-admin uses the pins', () => {
    const checked = { firebase: [] as string[], admin: [] as string[] };
    for (const name of TEMPLATE_NAMES) {
      const template = TEMPLATES[name];
      for (const deps of [template.dependencies, template.devDependencies]) {
        if (deps?.firebase !== undefined) {
          expect({ name, firebase: deps.firebase }).toEqual({ name, firebase: FIREBASE_PIN });
          checked.firebase.push(name);
        }
        if (deps?.['firebase-admin'] !== undefined) {
          expect({ name, admin: deps['firebase-admin'] }).toEqual({ name, admin: FIREBASE_ADMIN_PIN });
          checked.admin.push(name);
        }
      }
    }
    // A loop that matched nothing would pass without checking a pin.
    expect(checked.firebase).toEqual(expect.arrayContaining(['web', 'node', 'static', 'chat', 'nextjs']));
    expect(checked.admin).toEqual(expect.arrayContaining(['chat', 'nextjs']));
  });

  test('the chat template and its functions package use the pins', () => {
    const chat = readManifest('chat/package.json');
    expect(chat.dependencies?.firebase).toBe(FIREBASE_PIN);
    expect(chat.devDependencies?.['firebase-admin']).toBe(FIREBASE_ADMIN_PIN);
    const functions = readManifest('chat/functions/package.json');
    expect(functions.dependencies?.['firebase-admin']).toBe(FIREBASE_ADMIN_PIN);
  });

  test('the firebase pin supports the limited-use App Check tokens the chat template asks for', () => {
    // Found first, so renaming the file or the option fails here instead of skipping the check.
    expect(readTemplate(CHAT_FIREBASE_APP)).toMatch(/useLimitedUseAppCheckTokens:\s*true/);
    const floor = pinFloor(FIREBASE_PIN);
    expect({ pin: FIREBASE_PIN, supported: isAtLeast(floor, LIMITED_USE_TOKENS_FLOOR) }).toEqual({
      pin: FIREBASE_PIN,
      supported: true,
    });
  });

  test('resolves the certified firebase-admin version without relying on root hoisting (#1225)', () => {
    const tmpRoot = createPrivateJobTmpDir('pin-iso');
    tempRoots.push(tmpRoot);
    const isoCreate = join(tmpRoot, 'packages', 'create-pyric');
    const isoCliVersion = join(tmpRoot, 'packages', 'cli', 'src', 'version');
    const isoConformance = join(tmpRoot, 'packages', 'conformance');
    const isoScriptsLib = join(tmpRoot, 'scripts', 'lib');

    mkdirSync(join(isoCreate, 'test'), { recursive: true });
    mkdirSync(isoCliVersion, { recursive: true });
    mkdirSync(join(isoConformance, 'src'), { recursive: true });
    mkdirSync(isoScriptsLib, { recursive: true });

    cpSync(join(CREATE_PYRIC_DIR, 'package.json'), join(isoCreate, 'package.json'));
    cpSync(join(CREATE_PYRIC_DIR, 'src'), join(isoCreate, 'src'), { recursive: true });
    cpSync(TEMPLATES_DIR, join(isoCreate, 'templates'), { recursive: true });
    cpSync(join(CREATE_PYRIC_DIR, 'test', 'firebase-pins.test.ts'), join(isoCreate, 'test', 'firebase-pins.test.ts'));
    writeFileSync(join(isoCreate, 'bunfig.toml'), '');

    cpSync(join(REPO_ROOT, 'packages', 'cli', 'src', 'version', 'compat-target.ts'), join(isoCliVersion, 'compat-target.ts'));
    cpSync(join(REPO_ROOT, 'packages', 'conformance', 'src', 'package-version.ts'), join(isoConformance, 'src', 'package-version.ts'));
    cpSync(join(REPO_ROOT, 'scripts', 'lib', 'private-job-tmpdir.ts'), join(isoScriptsLib, 'private-job-tmpdir.ts'));

    // Link node_modules only under packages/conformance (never at tmpRoot or create-pyric),
    // matching an isolated linker where create-pyric cannot resolve undeclared firebase-admin.
    const conformanceAdminSource = fileURLToPath(
      import.meta.resolve('firebase-admin', new URL('../../conformance/src/package-version.ts', import.meta.url).href),
    );
    const adminNodeModulesIdx = conformanceAdminSource.lastIndexOf('/node_modules/');
    expect(adminNodeModulesIdx).toBeGreaterThanOrEqual(0);
    const sourceNodeModules = conformanceAdminSource.slice(0, adminNodeModulesIdx + '/node_modules'.length);
    symlinkSync(sourceNodeModules, join(isoConformance, 'node_modules'));

    const unhoistedRequire = createRequire(join(isoCreate, 'test', 'firebase-pins.test.ts'));
    expect(() => unhoistedRequire.resolve('firebase-admin/package.json')).toThrow();

    const child = spawnSync(
      process.execPath,
      ['test', 'test/firebase-pins.test.ts', '-t', 'firebase-admin is a patch range'],
      { cwd: isoCreate, encoding: 'utf8' },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: expect.stringContaining('1 pass'),
    });
  }, 15_000);
});
