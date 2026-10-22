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

function readManifest(path: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(TEMPLATES_DIR, path), 'utf8')) as Record<string, Record<string, string> | undefined>;
}

describe('scaffold Firebase pins', () => {
  test('firebase is a patch range on the certified version', () => {
    expect(FIREBASE_PIN).toBe(`~${FIREBASE_TESTED_AGAINST}`);
  });

  test('firebase-admin is a patch range on the version the observations were captured against', () => {
    expect(FIREBASE_ADMIN_PIN).toBe(`~${installedAdminVersion()}`);
  });

  test('every template that names firebase or firebase-admin uses the pins', () => {
    for (const name of TEMPLATE_NAMES) {
      const template = TEMPLATES[name];
      for (const deps of [template.dependencies, template.devDependencies]) {
        if (deps?.firebase !== undefined) expect({ name, firebase: deps.firebase }).toEqual({ name, firebase: FIREBASE_PIN });
        if (deps?.['firebase-admin'] !== undefined) {
          expect({ name, admin: deps['firebase-admin'] }).toEqual({ name, admin: FIREBASE_ADMIN_PIN });
        }
      }
    }
  });

  test('the chat template and its functions package use the pins', () => {
    const chat = readManifest('chat/package.json');
    expect(chat.dependencies?.firebase).toBe(FIREBASE_PIN);
    expect(chat.devDependencies?.['firebase-admin']).toBe(FIREBASE_ADMIN_PIN);
    const functions = readManifest('chat/functions/package.json');
    expect(functions.dependencies?.['firebase-admin']).toBe(FIREBASE_ADMIN_PIN);
  });
});
