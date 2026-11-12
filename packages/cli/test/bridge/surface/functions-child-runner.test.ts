/**
 * Mirrored unit tests for `src/bridge/surface/functions-child-runner.ts`:
 * verifies the isolated Swap-or-Stop child runner executes discovery and
 * synthetic RTDB `onValueCreated` triggers with `GOOGLE_APPLICATION_CREDENTIALS`
 * stripped and `pyric-admin` bridged back to the caller's sandbox.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { get as getRtdb, ref as rtdbRef } from 'pyric/database';
import { createSurfaceContext } from '../../../src/bridge/surface/index.js';
import {
  discoverFunctionsTriggers,
  fireFunctionsTriggerIsolated,
} from '../../../src/bridge/surface/functions-runtime.js';
import { FUNCTIONS_RUNNER_CHILD_ENV } from '../../../src/bridge/surface/functions-child-runner.js';
import { databaseFor } from '../../../src/bridge/surface/service-handles.js';

describe('functions-child-runner isolated execution', () => {
  it('discovers and executes RTDB triggers in a Swap-or-Stop child bridged over IPC', async () => {
    expect(FUNCTIONS_RUNNER_CHILD_ENV).toBe('PYRIC_FUNCTIONS_RUNNER_CHILD');

    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-test-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-runner-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "import { getApps, initializeApp } from 'firebase-admin/app';",
        "export const onNoteCreated = onValueCreated('/notes/{noteId}', async (event) => {",
        "  const app = getApps()[0] ?? initializeApp();",
        "  await event.data.ref.parent.child('summary').set(String(event.data.val()?.body ?? ''));",
        "  return { swapped: 'sandbox' in app, adc: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null };",
        "});",
      ].join('\n'),
    );

    const prevAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'synthetic-runner-adc.json';
    const sandbox = initializeSandbox();
    try {
      const discovered = await discoverFunctionsTriggers(dir);
      expect(discovered.triggers.map((t) => t.exportName)).toEqual(['onNoteCreated']);

      const ctx = createSurfaceContext(sandbox, dir);
      const firedParams: Record<string, string>[] = [];
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onNoteCreated',
        path: 'notes/n1',
        ref: 'notes/n1',
        value: { body: 'isolated-ok' },
        timeoutMs: 10_000,
        onFiring(_trigger, params) {
          firedParams.push(params);
        },
      });
      expect(outcome.kind).toBe('executed');
      if (outcome.kind === 'executed') {
        expect(outcome.status).toBe('fulfilled');
        expect(outcome.result).toEqual({ swapped: true, adc: null });
      }
      expect(firedParams).toEqual([{ noteId: 'n1' }]);

      const summarySnap = await getRtdb(rtdbRef(databaseFor(ctx), 'notes/summary'));
      expect(summarySnap.val()).toBe('isolated-ok');
    } finally {
      if (prevAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevAdc;
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes queued RTDB onDisconnect ops, resolves default instance URLs on secondary apps, and cleans up listeners on exit and timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-disconnect-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-disconnect-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "import { getApps, initializeApp } from 'firebase-admin/app';",
        "import { getDatabaseWithUrl } from 'firebase-admin/database';",
        "export const onSessionOpened = onValueCreated('/sessions/{sessionId}', async (event) => {",
        "  const primary = getApps()[0] ?? initializeApp();",
        "  const aux = initializeApp({}, 'aux-worker');",
        "  const auxDb = getDatabaseWithUrl('https://demo-proj-default-rtdb.firebaseio.com', aux);",
        "  auxDb.ref('/watched/aux').on('value', () => {});",
        "  await auxDb.ref('/status/' + event.params.sessionId).set('active');",
        "  await primary.sandbox.channel.op({",
        "    method: 'rtdb.onDisconnectSet',",
        "    path: '/presence/' + event.params.sessionId,",
        "    value: 'disconnected',",
        "    actAs: { mode: 'admin' },",
        "  });",
        "  return { ok: true };",
        "});",
        "export const onSlowSession = onValueCreated('/slow/{sessionId}', async (event) => {",
        "  const primary = getApps()[0] ?? initializeApp();",
        "  const aux = initializeApp({}, 'aux-slow');",
        "  const auxDb = getDatabaseWithUrl('https://demo-proj-default-rtdb.firebaseio.com', aux);",
        "  auxDb.ref('/watched/slow').on('value', () => {});",
        "  await primary.sandbox.channel.op({",
        "    method: 'rtdb.onDisconnectSet',",
        "    path: '/presence/' + event.params.sessionId,",
        "    value: 'timed-out-disconnected',",
        "    actAs: { mode: 'admin' },",
        "  });",
        "  await new Promise(() => {});",
        "});",
      ].join('\n'),
    );

    const sandbox = initializeSandbox();
    try {
      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onSessionOpened',
        path: 'sessions/s1',
        ref: 'sessions/s1',
        value: { active: true },
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(outcome.kind).toBe('executed');

      const db = databaseFor(ctx);
      const statusSnap = await getRtdb(rtdbRef(db, 'status/s1'));
      expect(statusSnap.val()).toBe('active');
      const presenceSnap = await getRtdb(rtdbRef(db, 'presence/s1'));
      expect(presenceSnap.val()).toBe('disconnected');

      const slowOutcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onSlowSession',
        path: 'slow/s2',
        ref: 'slow/s2',
        value: { active: true },
        timeoutMs: 200,
        onFiring() {},
      });
      expect(slowOutcome.kind).toBe('timed-out');

      const slowPresenceSnap = await getRtdb(rtdbRef(db, 'presence/s2'));
      expect(slowPresenceSnap.val()).toBe('timed-out-disconnected');
    } finally {
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
