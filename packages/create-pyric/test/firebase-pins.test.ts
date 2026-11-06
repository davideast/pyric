/**
 * The scaffold pins stay on the certified Firebase lines (#1188). `firebase`
 * must be a patch range on FIREBASE_TESTED_AGAINST, and `firebase-admin` a
 * patch range on the installed firebase-admin, the version
 * `compat:oracle-versions` checks the observations against. The chat
 * template's package.json files are static assets, so this test holds them to
 * the same pins.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIREBASE_TESTED_AGAINST } from '../../cli/src/version/compat-target.ts';
import { FIREBASE_ADMIN_PIN, FIREBASE_PIN } from '../src/firebase-pins.ts';
import { TEMPLATES, TEMPLATE_NAMES } from '../src/templates.ts';

const require = createRequire(import.meta.url);
const TEMPLATES_DIR = join(import.meta.dir, '..', 'templates');

function installedAdminVersion(): string {
  const manifest = require('firebase-admin/package.json') as { version: string };
  return manifest.version;
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
});
