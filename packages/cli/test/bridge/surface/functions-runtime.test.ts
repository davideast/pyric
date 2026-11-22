import { afterEach, describe, expect, test } from 'bun:test';
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

const tempDirs: string[] = [];

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-functions-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function plantFunctionsSource(projectDir: string, source: string): void {
  mkdirSync(join(projectDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(
    join(projectDir, 'firebase.json'),
    JSON.stringify({ functions: { source: 'functions' } }),
  );
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
      eventType: 'google.firebase.database.ref.v1.created',
      reference: 'messages/{pushId}/original',
    });
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'turnedOff',
        eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
      },
    ]);
  });

  test('surfaces supported triggers across all sandbox families and reports unsupported exports with matching reasons (#1941)', async () => {
    const projectDir = fixtureProject();
    const sandbox = initializeSandbox();
    try {
      plantFunctionsSource(
        projectDir,
        [
          "const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');",
          "const { onDocumentCreated } = require('firebase-functions/v2/firestore');",
          "const { onObjectFinalized } = require('firebase-functions/v2/storage');",
          "const { onSchedule } = require('firebase-functions/v2/scheduler');",
          "const { beforeUserCreated } = require('firebase-functions/v2/identity');",
          "const { onMessagePublished } = require('firebase-functions/v2/pubsub');",
          "const { onTaskDispatched } = require('firebase-functions/v2/tasks');",
          "const { onRequest, onCall } = require('firebase-functions/v2/https');",
          "const v1 = require('firebase-functions/v1');",
          "exports.rtdbCreate = onValueCreated('/messages/{id}', () => undefined);",
          "exports.rtdbUpdate = onValueUpdated('/messages/{id}', () => undefined);",
          "exports.docCreated = onDocumentCreated('users/{uid}', () => undefined);",
          'exports.objectFinalized = onObjectFinalized(() => undefined);',
          "exports.nightlySchedule = onSchedule('every 5 minutes', () => undefined);",
          'exports.authGate = beforeUserCreated(() => undefined);',
          "exports.topicWorker = onMessagePublished('orders', () => undefined);",
          'exports.taskWorker = onTaskDispatched(() => undefined);',
          "exports.httpApi = onRequest((_req, res) => res.send('ok'));",
          'exports.callableSave = onCall(() => ({ ok: true }));',
          "exports.badDocPattern = onDocumentCreated('users', () => undefined);",
          "exports.badCron = onSchedule('99 * * * *', () => undefined);",
          'exports.omittedBlocking = beforeUserCreated({ omit: true }, () => undefined);',
          "exports.legacyV1Firestore = v1.firestore.document('users/{uid}').onCreate(() => null);",
        ].join('\n'),
      );

      const ctx = createSurfaceContext(sandbox, projectDir);
      const listed = await listTriggersMethod.handler({}, ctx);
      expect(listed.ok).toBe(true);
      expect(listed.summary).toBe('10 trigger(s), 4 unsupported');

      const data = listed.data as {
        triggers: Array<Record<string, unknown>>;
        unsupported: Array<{ exportName: string; eventType: string }>;
      };
      expect(data.triggers.map((t) => [t.exportName, t.eventType])).toEqual([
        ['rtdbCreate', 'google.firebase.database.ref.v1.created'],
        ['rtdbUpdate', 'google.firebase.database.ref.v1.updated'],
        ['docCreated', 'google.cloud.firestore.document.v1.created'],
        ['objectFinalized', 'google.cloud.storage.object.v1.finalized'],
        ['nightlySchedule', 'schedule'],
        ['authGate', 'providers/cloud.auth/eventTypes/user.beforeCreate'],
        ['topicWorker', 'google.cloud.pubsub.topic.v1.messagePublished'],
        ['taskWorker', 'task-queue'],
        ['httpApi', 'https'],
        ['callableSave', 'callable'],
      ]);
      expect(data.triggers[2]).toEqual({
        exportName: 'docCreated',
        eventType: 'google.cloud.firestore.document.v1.created',
        document: 'users/{uid}',
        database: '(default)',
        namespace: '(default)',
      });
      expect(data.triggers[4]).toEqual({
        exportName: 'nightlySchedule',
        eventType: 'schedule',
        schedule: 'every 5 minutes',
        regions: ['us-central1'],
      });
      expect(data.unsupported).toEqual([
        {
          exportName: 'badDocPattern',
          eventType:
            'google.cloud.firestore.document.v1.created (unsupported document pattern: users)',
        },
        {
          exportName: 'badCron',
          eventType: "schedule (invalid schedule: value '99' out of range for minute field)",
        },
        {
          exportName: 'omittedBlocking',
          eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate (omitted from emulation)',
        },
        {
          exportName: 'legacyV1Firestore',
          eventType: 'providers/cloud.firestore/eventTypes/document.create',
        },
      ]);
    } finally {
      sandbox.dispose();
    }
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
    expect(discovered.triggers.map((t) => [t.exportName, t.eventType])).toEqual([
      ['onCreated', 'google.firebase.database.ref.v1.created'],
      ['api', 'https'],
    ]);
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'omittedHttp',
        eventType: 'https (omitted from emulation)',
      },
    ]);
  });

  test('recognizes supported onCall exports and reports omitted onCall exports cleanly', async () => {
    const projectDir = fixtureProject();
    plantFunctionsSource(
      projectDir,
      `const { onValueCreated } = require('firebase-functions/v2/database');
const { onCall } = require('firebase-functions/v2/https');
exports.onCreated = onValueCreated('/items/{id}', () => undefined);
exports.saveItem = onCall(() => ({ ok: true }));
exports.omittedCall = onCall({ omit: true }, () => ({ ok: false }));
`,
    );
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers.map((t) => [t.exportName, t.eventType])).toEqual([
      ['onCreated', 'google.firebase.database.ref.v1.created'],
      ['saveItem', 'callable'],
    ]);
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'omittedCall',
        eventType: 'callable (omitted from emulation)',
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
          '  instance: event.instance,',
          '  gcloudProject: process.env.GCLOUD_PROJECT,',
          '}));',
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
      const listedTriggers = (listed.data as { triggers: Array<{ instance?: string }> }).triggers;
      expect(listedTriggers[0]?.instance).toBe('org-alpha-default-rtdb');

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
      writeFileSync(
        join(projectDir, '.firebaserc'),
        JSON.stringify({ projects: { default: 'org-alpha' } }),
      );
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
      const listedTriggers = (listed.data as { triggers: Array<{ instance?: string }> }).triggers;
      expect(listedTriggers[0]?.instance).toBe('custom-rtdb');

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
    }
  });
});
