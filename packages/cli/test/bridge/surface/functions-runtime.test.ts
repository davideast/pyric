import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverFunctionsTriggers } from '../../../src/bridge/surface/functions-runtime.js';

const firebaseFunctionsPath = resolve(
  import.meta.dir,
  '../../../../conformance/node_modules/firebase-functions',
);

function fixtureProject(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-functions-runtime-'));
}

function plantFunctionsSource(projectDir: string, source: string): void {
  mkdirSync(join(projectDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(projectDir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
  writeFileSync(
    join(projectDir, 'functions/package.json'),
    JSON.stringify({ name: 'fixture-functions', private: true, main: 'index.js' }),
  );
  writeFileSync(join(projectDir, 'functions/index.js'), source);
  symlinkSync(firebaseFunctionsPath, join(projectDir, 'functions/node_modules/firebase-functions'));
}

describe('discoverFunctionsTriggers', () => {
  test('reports an empty discovery, naming where it looked, when the project declares no functions source', async () => {
    const projectDir = fixtureProject();
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers).toEqual([]);
    expect(discovered.unsupported).toEqual([]);
    expect(discovered.lookedAt).toBe(`${projectDir}/firebase.json`);
  });

  test('discovers a supported onValueCreated export and names an unsupported one with its reason', async () => {
    const projectDir = fixtureProject();
    plantFunctionsSource(
      projectDir,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated('/messages/{pushId}/original', (event) => (
  event.data.val().toUpperCase()
));
exports.turnedOff = onValueCreated({ ref: '/messages/{id}', omit: true }, () => undefined);
`,
    );
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers).toHaveLength(1);
    expect(discovered.triggers[0]).toMatchObject({
      exportName: 'makeUppercase',
      reference: 'messages/{pushId}/original',
    });
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'turnedOff',
        eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
      },
    ]);
  });

  test('reports non-created RTDB, Firestore, and Storage trigger exports as unsupported', async () => {
    const projectDir = fixtureProject();
    plantFunctionsSource(
      projectDir,
      `const { onValueCreated, onValueUpdated, onValueDeleted } = require('firebase-functions/v2/database');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
exports.validCreate = onValueCreated('/messages/{id}', () => undefined);
exports.onUpdated = onValueUpdated('/messages/{id}', () => undefined);
exports.onDeleted = onValueDeleted('/messages/{id}', () => undefined);
exports.onDocCreated = onDocumentCreated('messages/{id}', () => undefined);
`,
    );
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers.map((t) => t.exportName)).toEqual(['validCreate']);
    expect(discovered.unsupported.map((u) => u.exportName)).toEqual([
      'onUpdated',
      'onDeleted',
      'onDocCreated',
    ]);
  });

  test('recognizes supported https onRequest exports and reports omitted onRequest exports cleanly', async () => {
    const projectDir = fixtureProject();
    plantFunctionsSource(
      projectDir,
      `const { onValueCreated } = require('firebase-functions/v2/database');
const { onRequest } = require('firebase-functions/v2/https');
exports.onCreated = onValueCreated('/items/{id}', () => undefined);
exports.api = onRequest((_req, res) => res.send('ok'));
exports.omittedHttp = onRequest({ omit: true }, (_req, res) => res.send('skip'));
`,
    );
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers.map((t) => t.exportName)).toEqual(['onCreated']);
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'omittedHttp',
        eventType: 'https (omitted from emulation)',
      },
    ]);
  });
});
