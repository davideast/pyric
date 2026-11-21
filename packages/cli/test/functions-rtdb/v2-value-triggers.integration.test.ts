import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildChildEnv,
  registerModuleUrl,
} from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

let fixtureDir: string;
let runtime: ServeRuntime;
let peer: { close(): Promise<void> };
let observer: RemoteSandbox;
let child: FunctionsChildHandle | undefined;

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error('Timed out waiting for RTDB v2 trigger integration condition.');
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built -- run bun run --cwd packages/cli build (${childModule})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-functions-rtdb-v2-'));
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({ hosting: { public: 'public' } }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'rtdb-v2-all-triggers', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    [
      "const { onValueCreated, onValueUpdated, onValueDeleted, onValueWritten } = require('firebase-functions/v2/database');",
      "const functionsV1 = require('firebase-functions/v1');",
      '',
      "exports.onTicketCreated = onValueCreated('/tickets/{ticketId}', async (event) => {",
      "  await event.data.ref.root.child('audit/created/' + event.params.ticketId).set({",
      "    type: event.type,",
      "    val: event.data.val(),",
      "  });",
      "});",
      '',
      "exports.onTicketUpdated = onValueUpdated('/tickets/{ticketId}', async (event) => {",
      "  await event.data.after.ref.root.child('audit/updated').push({",
      "    ticketId: event.params.ticketId,",
      "    type: event.type,",
      "    before: event.data.before.val(),",
      "    after: event.data.after.val(),",
      "  });",
      "});",
      '',
      "exports.onTicketDeleted = onValueDeleted('/tickets/{ticketId}', async (event) => {",
      "  await event.data.ref.root.child('audit/deleted/' + event.params.ticketId).set({",
      "    type: event.type,",
      "    existed: event.data.exists(),",
      "    removed: event.data.val(),",
      "  });",
      "});",
      '',
      "exports.onSlugWritten = onValueWritten('/slugs/{slugId}', async (event) => {",
      "  await event.data.after.ref.root.child('audit/slugWrites').push({",
      "    slugId: event.params.slugId,",
      "    type: event.type,",
      "    beforeExists: event.data.before.exists(),",
      "    afterExists: event.data.after.exists(),",
      "    beforeIsNull: event.data.before.val() === null,",
      "    afterIsNull: event.data.after.val() === null,",
      "    before: event.data.before.val(),",
      "    after: event.data.after.val(),",
      "  });",
      "  if (!event.data.after.exists()) return;",
      "  const current = String(event.data.after.val());",
      "  const normalized = current.trim().toLowerCase();",
      "  if (current !== normalized) {",
      "    await event.data.after.ref.set(normalized);",
      "  }",
      "});",
      '',
      "exports.omittedWritten = onValueWritten({ ref: '/tickets/{ticketId}', omit: true }, () => undefined);",
      "exports.legacyV1 = functionsV1.database.ref('/tickets/{ticketId}').onUpdate(() => null);",
    ].join('\n'),
  );
  writeFileSync(
    join(fixtureDir, 'functions/shard.cjs'),
    [
      "const { onValueUpdated, onValueDeleted } = require('firebase-functions/v2/database');",
      "exports.onShardUpdated = onValueUpdated(",
      "  { ref: '/shard-orders/{orderId}/status', instance: 'demo-project-shard-v2', region: 'europe-west1' },",
      "  (event) => event.data.after.ref.parent.child('transition').set(",
      "    event.location + ':' + event.data.before.val() + '->' + event.data.after.val()",
      "  ),",
      ");",
      "exports.onShardDeleted = onValueDeleted(",
      "  { ref: '/shard-orders/{orderId}/status', instance: 'demo-project-shard-v2' },",
      "  (event) => event.data.ref.parent.child('deletedStatus').set(event.data.val()),",
      ");",
    ].join('\n'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-rtdb-v2',
    instanceId: 'functions-rtdb-v2-peer',
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx,
    sandboxId: 'functions-rtdb-v2-peer',
  });
  observer = await connectRemoteSandbox({ url: runtime.handle.url });
});

afterEach(async () => {
  if (child !== undefined) {
    await child.stop();
    child = undefined;
  }
});

afterAll(async () => {
  if (child !== undefined) {
    await child.stop();
    child = undefined;
  }
  observer?.close();
  if (peer) await peer.close();
  if (runtime) await runtime.handle.stop();
});

describe('isolated Functions child with all four v2 RTDB triggers', () => {
  test('drives onValueCreated, onValueUpdated, onValueDeleted, and guarded re-entrant onValueWritten end to end', async () => {
    const events: FunctionsChildEvent[] = [];
    const localChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });
    child = localChild;
    try {
      expect(await localChild.ready).toEqual({
        triggerCount: 4,
        unsupportedTriggers: [
          {
            exportName: 'omittedWritten',
            eventType: 'google.firebase.database.ref.v1.written (omitted from emulation)',
          },
          {
            exportName: 'legacyV1',
            eventType: 'providers/google.firebase.database/eventTypes/ref.update',
          },
        ],
      });

      // 1. Create + update (removing `legacyTag`) + delete on `/tickets/t-42`.
      await observer.rtdb.set('tickets/t-42', { title: 'Draft', legacyTag: 'v0' });
      await waitForCondition(async () => (await observer.rtdb.get('audit/created/t-42')) !== null);

      await observer.rtdb.update('tickets/t-42', { title: 'Published', legacyTag: null });
      await waitForCondition(async () => {
        const updated = await observer.rtdb.get('audit/updated');
        return typeof updated === 'object' && updated !== null && Object.keys(updated).length === 1;
      });

      await observer.rtdb.remove('tickets/t-42');
      await waitForCondition(async () => (await observer.rtdb.get('audit/deleted/t-42')) !== null);

      expect(await observer.rtdb.get('audit/created/t-42')).toEqual({
        type: 'google.firebase.database.ref.v1.created',
        val: { title: 'Draft', legacyTag: 'v0' },
      });

      const updatedMap = (await observer.rtdb.get('audit/updated')) as Record<string, unknown>;
      expect(Object.values(updatedMap)).toEqual([
        {
          ticketId: 't-42',
          type: 'google.firebase.database.ref.v1.updated',
          before: { title: 'Draft', legacyTag: 'v0' },
          after: { title: 'Published' },
        },
      ]);

      expect(await observer.rtdb.get('audit/deleted/t-42')).toEqual({
        type: 'google.firebase.database.ref.v1.deleted',
        existed: true,
        removed: { title: 'Published' },
      });

      // 2. Re-entrant self-normalizing `onValueWritten` fires create -> self-update -> delete cleanly without looping.
      await observer.rtdb.set('slugs/s1', '  Hello-World  ');
      await waitForCondition(async () => (await observer.rtdb.get('slugs/s1')) === 'hello-world');

      await observer.rtdb.remove('slugs/s1');
      await waitForCondition(async () => {
        const writes = await observer.rtdb.get('audit/slugWrites');
        return typeof writes === 'object' && writes !== null && Object.keys(writes).length === 3;
      });

      const slugWrites = Object.values(
        (await observer.rtdb.get('audit/slugWrites')) as Record<string, unknown>,
      );
      expect(slugWrites).toEqual([
        {
          slugId: 's1',
          type: 'google.firebase.database.ref.v1.written',
          beforeExists: false,
          afterExists: true,
          beforeIsNull: true,
          afterIsNull: false,
          after: '  Hello-World  ',
        },
        {
          slugId: 's1',
          type: 'google.firebase.database.ref.v1.written',
          beforeExists: true,
          afterExists: true,
          beforeIsNull: false,
          afterIsNull: false,
          before: '  Hello-World  ',
          after: 'hello-world',
        },
        {
          slugId: 's1',
          type: 'google.firebase.database.ref.v1.written',
          beforeExists: true,
          afterExists: false,
          beforeIsNull: false,
          afterIsNull: true,
          before: 'hello-world',
        },
      ]);

      const rejected = events.filter(
        (item) => item.type === 'execution' && item.status === 'rejected',
      );
      expect(rejected).toEqual([]);
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 20_000);

  test('filters onValueUpdated and onValueDeleted by named RTDB instance and preserves custom location', async () => {
    const localChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/shard.cjs'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });
    child = localChild;
    try {
      expect((await localChild.ready).triggerCount).toBe(2);

      const shard = observer.rtdb.forInstance('demo-project-shard-v2');
      await observer.rtdb.set('shard-orders/ord-1/status', 'pending');
      await observer.rtdb.set('shard-orders/ord-1/status', 'shipped');

      await shard.set('shard-orders/ord-1/status', 'pending');
      await shard.set('shard-orders/ord-1/status', 'shipped');
      await waitForCondition(
        async () =>
          (await shard.get('shard-orders/ord-1/transition')) === 'europe-west1:pending->shipped',
      );

      await shard.remove('shard-orders/ord-1/status');
      await waitForCondition(
        async () => (await shard.get('shard-orders/ord-1/deletedStatus')) === 'shipped',
      );

      expect(await observer.rtdb.get('shard-orders/ord-1/transition')).toBeNull();
    } finally {
      expect(await localChild.stop()).toBe(0);
      if (child === localChild) child = undefined;
    }
  }, 15_000);
});
