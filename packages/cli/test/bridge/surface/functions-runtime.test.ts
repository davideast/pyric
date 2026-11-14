import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { createSurfaceContext } from '../../../src/bridge/surface/index.js';
import { projectDatabaseInstances } from '../../../src/bridge/surface/database-instance-project.js';
import {
  discoverFunctionsTriggers,
  fireFunctionsTriggerIsolated,
} from '../../../src/bridge/surface/functions-runtime.js';
import listTriggersMethod from '../../../src/bridge/surface/methods/functions/listTriggers.js';

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

  test('resolves pyric.json project without .firebaserc across discovery, listTriggers, fire, and database catalog', async () => {
    const projectDir = fixtureProject();
    const sandbox = initializeSandbox();
    try {
      plantFunctionsSource(
        projectDir,
        [
          "const { onValueCreated } = require('firebase-functions/v2/database');",
          "const cfg = JSON.parse(process.env.FIREBASE_CONFIG || '{}');",
          "const defaultInstance = cfg.databaseURL ? new URL(cfg.databaseURL).hostname.split('.')[0] : 'unset';",
          "exports.onTaskCreated = onValueCreated({ ref: '/tasks/{taskId}', instance: defaultInstance }, (event) => ({",
          "  instance: event.instance,",
          "  gcloudProject: process.env.GCLOUD_PROJECT,",
          "}));",
        ].join('\n'),
      );
      writeFileSync(join(projectDir, 'pyric.json'), JSON.stringify({ project: 'org-alpha' }));

      const catalog = await projectDatabaseInstances(sandbox, projectDir);
      expect(catalog.select('org-alpha-default-rtdb')).toBeUndefined();

      const standalone = await discoverFunctionsTriggers(projectDir);
      expect(standalone.triggers[0]?.instance).toBe('org-alpha-default-rtdb');

      const ctx = createSurfaceContext(sandbox, projectDir);
      const listed = await listTriggersMethod.handler({}, ctx);
      expect(listed.ok).toBe(true);
      expect(listed.data.triggers[0]?.instance).toBe('org-alpha-default-rtdb');

      const fired = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onTaskCreated',
        path: 'tasks/t1',
        ref: 'tasks/t1',
        value: { title: 'ship' },
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(fired.kind).toBe('executed');
      if (fired.kind === 'executed') {
        expect(fired.trigger.instance).toBe('org-alpha-default-rtdb');
        expect(fired.result).toEqual({
          instance: 'org-alpha-default-rtdb',
          gcloudProject: 'org-alpha',
        });
      }
    } finally {
      sandbox.dispose();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('agrees on a configured default database instance across discoverFunctionsTriggers, listTriggers, and fire', async () => {
    const projectDir = fixtureProject();
    const sandbox = initializeSandbox();
    try {
      plantFunctionsSource(
        projectDir,
        [
          "const { onValueCreated } = require('firebase-functions/v2/database');",
          "const cfg = JSON.parse(process.env.FIREBASE_CONFIG || '{}');",
          "const defaultInstance = cfg.databaseURL ? new URL(cfg.databaseURL).hostname.split('.')[0] : 'unset';",
          "exports.onEntryCreated = onValueCreated({ ref: '/entries/{entryId}', instance: defaultInstance }, (event) => event.instance);",
        ].join('\n'),
      );
      writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
      writeFileSync(
        join(projectDir, 'database.rules.json'),
        JSON.stringify({ rules: { '.read': true, '.write': true } }),
      );
      writeFileSync(
        join(projectDir, 'firebase.json'),
        JSON.stringify({
          functions: { source: 'functions' },
          database: [{ instance: 'custom-rtdb', rules: 'database.rules.json' }],
        }),
      );

      const standalone = await discoverFunctionsTriggers(projectDir);
      expect(standalone.triggers[0]?.instance).toBe('custom-rtdb');

      const ctx = createSurfaceContext(sandbox, projectDir);
      const listed = await listTriggersMethod.handler({}, ctx);
      expect(listed.data.triggers[0]?.instance).toBe('custom-rtdb');

      const fired = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onEntryCreated',
        path: 'entries/e1',
        ref: 'entries/e1',
        value: 'ready',
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(fired.kind).toBe('executed');
      if (fired.kind === 'executed') {
        expect(fired.trigger.instance).toBe('custom-rtdb');
        expect(fired.result).toBe('custom-rtdb');
      }
    } finally {
      sandbox.dispose();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
