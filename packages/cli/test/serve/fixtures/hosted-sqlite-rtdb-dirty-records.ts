import assert from 'node:assert/strict';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bundleRecords, serializeToBuckets } from 'pyric/sandbox';
import { CHUNK_FORMAT_VERSION, decodeImportBundle } from 'pyric/sandbox/internal';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { replayRepro } from '../../../src/serve/repro/index.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

type Res = Extract<OutboundMessage, { t: 'res' }>;

const OPEN_RULES = { rules: { '.read': true, '.write': true } };
const DEFAULT_RULES = {
  rules: {
    workspaces: { '.read': true, '.write': true },
    locked: { '.read': false, '.write': false },
  },
};

async function openHost(directory: string) {
  mkdirSync(directory, { recursive: true });
  const waiting = new Map<string, (response: Res) => void>();
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: directory,
    },
    'http://127.0.0.1:1',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-message-result' && frame.message.t === 'res') {
        waiting.get(`${frame.clientSessionId}:${(frame.message as Res).id}`)?.(frame.message as Res);
      }
    },
    directory,
  );
  let seq = 0;
  return {
    runtime,
    request(session: string, message: Record<string, unknown>): Promise<Res> {
      const id = `op-${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out on ${id}`)), 4_000);
        waiting.set(`${session}:${id}`, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        runtime.receive({
          type: 'worker-message',
          clientSessionId: session,
          message: { t: 'op', id, ...message } as InboundMessage,
        });
      });
    },
  };
}

function readRawSqlitePayloads(hostedDir: string): Map<string, string> {
  const db = new DatabaseSync(join(hostedDir, 'state.sqlite'), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, payload FROM records WHERE namespace = 'hosted' ORDER BY id")
      .all() as Array<{ id: string; payload: string }>;
    return new Map(rows.map((r) => [r.id, r.payload]));
  } finally {
    db.close();
  }
}

const root = process.argv[2]!;

// 1. Partitioned SQLite records + single-bucket dirty write + export/import + reset + repro capture
{
  const projectDir = join(root, 'live-dirty');
  const hostedDir = hostedStateDirectory(projectDir);
  const host1 = await openHost(projectDir);
  try {
    await host1.runtime.deployRules('database', JSON.stringify(DEFAULT_RULES));
    await host1.runtime.deployRules('database', JSON.stringify(OPEN_RULES), 'secondary');

    for (let i = 0; i < 20; i++) {
      const res = await host1.request('seed', {
        method: 'rtdb.set',
        path: `workspaces/w-${i}/items/item-0`,
        value: { idx: i, text: `payload-${i}` },
      });
      assert.equal(res.ok, true);
    }
    assert.equal(
      (
        await host1.request('seed', {
          method: 'rtdb.setWithPriority',
          path: 'workspaces/w-0/cursors/u1',
          value: { x: 1, y: 2 },
          priority: 42,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await host1.request('seed', {
          method: 'rtdb.setWithPriority',
          instance: 'secondary',
          path: 'metrics/m1',
          value: { count: 9 },
          priority: 'prio-sec',
        })
      ).ok,
      true,
    );

    const beforeSmallWrite = readRawSqlitePayloads(hostedDir);
    const metaPayload = JSON.parse(beforeSmallWrite.get('meta')!) as { services: Record<string, unknown> };
    assert.equal('rtdb' in metaPayload.services, false, 'meta.services must not embed rtdb');
    assert.equal(beforeSmallWrite.has('rtdb:i:(default)'), true);
    assert.equal(beforeSmallWrite.has('rtdb:i:secondary'), true);
    const bucketKeysBefore = [...beforeSmallWrite.keys()].filter((id) => id.startsWith('rtdb:b:(default):'));
    assert.ok(bucketKeysBefore.length >= 5, `expected multiple shard buckets, got ${bucketKeysBefore.length}`);

    // Single small write touches ONLY 1 RTDB bucket row (+ meta).
    assert.equal(
      (
        await host1.request('writer', {
          method: 'rtdb.set',
          path: 'workspaces/w-0/cursors/u1',
          value: { x: 10, y: 20 },
        })
      ).ok,
      true,
    );

    const afterSmallWrite = readRawSqlitePayloads(hostedDir);
    const mutatedRtdbIds = [...afterSmallWrite.entries()]
      .filter(([id, payload]) => id.startsWith('rtdb:') && beforeSmallWrite.get(id) !== payload)
      .map(([id]) => id);
    assert.equal(mutatedRtdbIds.length, 1, `expected 1 mutated rtdb record, got ${JSON.stringify(mutatedRtdbIds)}`);
    assert.match(mutatedRtdbIds[0]!, /^rtdb:b:\(default\):[0-9a-f]{2}$/);

    // Repro base capture + replay across restarted host preserves both instances and rules.
    const exportedRes = await host1.request('exporter', { method: 'exportState' });
    assert.equal(exportedRes.ok, true);
    const exportedBundle = (exportedRes.value as { bundle?: string })?.bundle ?? (exportedRes.value as string);
    assert.equal(typeof exportedBundle, 'string');

    // Reset clears RTDB data and removes bucket rows; importState restores logical state, rules, and priorities.
    const resetRes = await host1.runtime.runMethod(
      { key: 'sandbox.reset', args: { scope: 'all', confirm: true }, projectDir },
      {},
    );
    assert.equal(resetRes.ok, true);
    const afterReset = readRawSqlitePayloads(hostedDir);
    assert.equal(
      [...afterReset.keys()].filter((id) => id.startsWith('rtdb:b:')).length,
      0,
      'sandbox.reset should remove persisted RTDB bucket rows',
    );

    const importRes = await host1.request('importer', { method: 'importState', bundle: exportedBundle });
    assert.equal(importRes.ok, true);

    const restoredCursor = await host1.request('reader', {
      method: 'rtdb.get',
      path: 'workspaces/w-0/cursors/u1',
    });
    assert.equal(restoredCursor.ok, true);
    assert.deepEqual((restoredCursor.value as { value: unknown }).value, { x: 10, y: 20 });

    const deniedLocked = await host1.request('reader', { method: 'rtdb.get', path: 'locked' });
    assert.equal(deniedLocked.ok, false);
  } finally {
    await host1.runtime.close();
  }

  // Reopen host over restored SQLite, perform another op, capture repro & verify replayRepro.
  const host2 = await openHost(projectDir);
  try {
    await host2.runtime.deployRules('database', JSON.stringify(OPEN_RULES), 'secondary');
    assert.equal(
      (
        await host2.request('client-2', {
          method: 'rtdb.set',
          path: 'workspaces/w-1/items/item-0',
          value: { idx: 1, text: 'updated-after-restart' },
        })
      ).ok,
      true,
    );
    const secRead = await host2.request('client-2', {
      method: 'rtdb.get',
      instance: 'secondary',
      path: 'metrics/m1',
    });
    assert.equal(secRead.ok, true);
    assert.deepEqual((secRead.value as { value: unknown; priority?: unknown }).value, { count: 9 });
    assert.equal(
      (secRead.value as { priority?: unknown }).priority,
      'prio-sec',
    );

    const repro = await host2.runtime.captureRepro();
    const replayReport = await replayRepro(repro);
    assert.equal(replayReport.ok, true, JSON.stringify(replayReport, null, 2));
  } finally {
    await host2.runtime.close();
  }
}

// 2. Hosted SQLite startup and salvage reject metadata version 3 and inline `meta.services.rtdb`
{
  const v3Project = join(root, 'rejected-v3');
  const v3Dir = hostedStateDirectory(v3Project);
  mkdirSync(v3Dir, { recursive: true });
  const v3Db = await openHostedDatabase(v3Dir);
  await v3Db.records.putRecords(
    'hosted',
    new Map<string, unknown>([['meta', { version: 3, savedAt: 50, services: {} }]]),
  );
  v3Db.close();
  await assert.rejects(() => openHost(v3Project), /salvage/);
  await assert.rejects(() => salvageHostedState(v3Dir, join(root, 'rejected-v3-out')), /Unsupported or malformed metadata/);

  const inlineProject = join(root, 'rejected-inline-rtdb');
  const inlineDir = hostedStateDirectory(inlineProject);
  mkdirSync(inlineDir, { recursive: true });
  const inlineDb = await openHostedDatabase(inlineDir);
  await inlineDb.records.putRecords(
    'hosted',
    new Map<string, unknown>([
      [
        'meta',
        {
          version: CHUNK_FORMAT_VERSION,
          savedAt: 50,
          services: {
            rtdb: {
              '.pyricRtdbPersistence': 1,
              data: { items: { a: 1 } },
              priorities: {},
            },
          },
        },
      ],
      ['00', { docs: { 'notes/kept': { ok: true } } }],
    ]),
  );
  inlineDb.close();
  await assert.rejects(() => openHost(inlineProject), /salvage/);

  const inlineSalvageOut = join(root, 'rejected-inline-salvaged');
  const inlineReport = await salvageHostedState(inlineDir, inlineSalvageOut);
  assert.equal(inlineReport.recoveredDocuments, 1);
  assert.equal(
    inlineReport.excluded.some(
      (entry) =>
        entry.namespace === 'services' &&
        entry.id === 'rtdb' &&
        entry.reason === 'Inline RTDB metadata service is unsupported',
    ),
    true,
  );
}

// 3. `state.writeSection('firestore', null)` preserves partitioned RTDB state
{
  const fsClearProject = join(root, 'fs-section-preserves-rtdb');
  const persistence = await createHostedPersistence(fsClearProject);
  try {
    const seeded = serializeToBuckets(
      { 'posts/one': { title: 'Keep RTDB' } },
      {
        rtdb: {
          '.pyricRtdbPersistence': 1,
          data: { workspaces: { w1: { items: { i1: { ok: true } } } } },
          priorities: { '/workspaces/w1/items/i1': 7 },
        },
      },
      10,
    );
    await persistence.state.writeSection('firestore', JSON.parse(bundleRecords(seeded)));
    await persistence.state.writeSection('firestore', null);

    const remainingSection = persistence.state.readSection('firestore');
    assert.notEqual(remainingSection, null, 'RTDB state must survive clearing Firestore documents');
    const decoded = decodeImportBundle(JSON.stringify(remainingSection));
    assert.deepEqual(decoded.firestore, {});
    assert.deepEqual(decoded.services.rtdb, {
      '.pyricRtdbPersistence': 1,
      data: { workspaces: { w1: { items: { i1: { ok: true } } } } },
      priorities: { '/workspaces/w1/items/i1': 7 },
    });
  } finally {
    persistence.close();
  }
}

// 4. `salvageHostedState` recovers valid RTDB buckets & headers while excluding a corrupted RTDB bucket
{
  const salvageProject = join(root, 'salvage-rtdb-src');
  const salvageSourceDir = join(root, 'salvage-rtdb-copy');
  const salvageOutDir = join(root, 'salvage-rtdb-out');

  const seededHost = await openHost(salvageProject);
  try {
    await seededHost.runtime.deployRules('database', JSON.stringify(OPEN_RULES));
    for (let i = 0; i < 16; i++) {
      assert.equal(
        (
          await seededHost.request('seed', {
            method: 'rtdb.set',
            path: `workspaces/w-${i}/items/item-0`,
            value: { idx: i },
          })
        ).ok,
        true,
      );
    }
  } finally {
    await seededHost.runtime.close();
  }

  cpSync(hostedStateDirectory(salvageProject), salvageSourceDir, { recursive: true });
  const corruptDb = new DatabaseSync(join(salvageSourceDir, 'state.sqlite'));
  const bucketRows = corruptDb
    .prepare("SELECT id, payload FROM records WHERE namespace = 'hosted' AND id LIKE 'rtdb:b:(default):%' ORDER BY id")
    .all() as Array<{ id: string; payload: string }>;
  assert.ok(bucketRows.length >= 2);
  const victimId = bucketRows[0]!.id;
  const victimJson = JSON.parse(bucketRows[0]!.payload) as { checksum: number };
  victimJson.checksum = (victimJson.checksum + 1) >>> 0;
  corruptDb
    .prepare("UPDATE records SET payload = ? WHERE namespace = 'hosted' AND id = ?")
    .run(JSON.stringify(victimJson), victimId);
  corruptDb.close();

  const report = await salvageHostedState(salvageSourceDir, salvageOutDir);
  assert.ok(report.recoveredServices >= 1);
  assert.equal(
    report.excluded.some((e) => e.id === victimId),
    true,
    `expected ${victimId} in excluded: ${JSON.stringify(report.excluded)}`,
  );

  const checkDb = await openHostedDatabase(salvageOutDir, { readOnly: true });
  try {
    const decoded = decodeImportBundle(bundleRecords(checkDb.readRecords('hosted')));
    const rtdbData = (decoded.services.rtdb as { data: { workspaces?: Record<string, unknown> } }).data;
    const recoveredCount = Object.keys(rtdbData.workspaces ?? {}).length;
    assert.ok(recoveredCount >= 1 && recoveredCount < 16, `expected partial recovery, got ${recoveredCount}`);
  } finally {
    checkDb.close();
  }
}

console.log('Hosted RTDB dirty records passed');
