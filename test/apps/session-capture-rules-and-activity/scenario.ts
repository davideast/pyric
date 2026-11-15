/**
 * End-to-end hosted sandbox scenario covering:
 * - Clean capture rotation across hosted `sandbox.reset` after named RTDB writes.
 * - Live active Firestore, RTDB, and Storage rules captured after `rules.set`.
 * - Strictly exclusive `sandbox.activity({ since })` cursor slicing across
 *   Firestore incidents and RTDB companion records.
 * - Preserving `observation_gap` records in `sandbox.events` after bounded
 *   denial retention eviction.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep, type App } from '../driver.ts';

interface ServePointer {
  url: string;
  instanceId: string;
}

interface MethodResponse {
  ok: boolean;
  summary: string;
  data?: unknown;
}

interface CapturedFixture {
  events: Array<Record<string, unknown>>;
  services: {
    firestore?: { rules: { source: string } };
    rtdb?: { rules: { json: unknown } };
    storage?: { rules: { source: string } };
  };
}

const UPDATED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
].join('\n');

const DENY_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if false;',
  '    }',
  '  }',
  '}',
].join('\n');

const UPDATED_RTDB_RULES = {
  rules: {
    nodes: {
      '.read': true,
      '.write': true,
    },
  },
};

const UPDATED_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /files/{name} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
].join('\n');

async function callHosted(
  pointer: ServePointer,
  projectDir: string,
  key: string,
  args: Record<string, unknown>,
): Promise<MethodResponse> {
  const response = await fetch(`${pointer.url}/__pyric/hosted/method`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instanceId: pointer.instanceId,
      projectDir,
      key,
      args,
      allowProduction: false,
    }),
  });
  assert.equal(response.status, 200, `hosted method ${key} returned HTTP ${response.status}`);
  return (await response.json()) as MethodResponse;
}

async function runPyricJson(app: App, args: string[]): Promise<MethodResponse> {
  const result = await app.pyric([...args, '--json']);
  assert.equal(result.code, 0, result.output);
  const start = result.output.indexOf('{');
  assert.ok(start >= 0, `expected JSON output from pyric ${args.join(' ')}:\n${result.output}`);
  return JSON.parse(result.output.slice(start)) as MethodResponse;
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const projectDir = realpathSync(app.dir);
  const pointerPath = join(app.dir, '.pyric', 'serve.json');
  const lastCapturePath = join(app.dir, '.pyric', 'last-session.json');
  const previousCapturePath = join(app.dir, '.pyric', 'previous-session.json');

  const host = await app.step('start the hosted sandbox server', async () => {
    const proc = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--no-run',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ]);
    const deadline = Date.now() + 60_000;
    while (!existsSync(pointerPath)) {
      if (Date.now() > deadline) {
        throw new Error(`serve.json was not written:\n${proc.output}`);
      }
      await sleep(150);
    }
    return proc;
  });

  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ServePointer;

  try {
    await app.step('hosted reset after named RTDB write rotates previous-session cleanly', async () => {
      const namedRules = await runPyricJson(app, [
        'rules',
        'set',
        '--service',
        'database',
        '--instance',
        'alt-db',
        '--rules',
        JSON.stringify({ rules: { '.read': true, '.write': true } }),
      ]);
      assert.equal(namedRules.ok, true);

      const rtdbWrite = await runPyricJson(app, [
        'database',
        'set',
        '--instance',
        'alt-db',
        '--path',
        'nodes/n1',
        '--value',
        '{"ok":true}',
      ]);
      assert.equal(rtdbWrite.ok, true);

      const resetRes = await runPyricJson(app, ['sandbox', 'reset', '--confirm']);
      assert.equal(resetRes.ok, true);
      const resetData = resetRes.data as {
        previousCapture?: { path: string; eventCount: number; denialCount: number };
      };
      assert.equal(resetData.previousCapture?.path, '.pyric/previous-session.json');
      assert.ok((resetData.previousCapture?.eventCount ?? 0) > 0);
      assert.equal(existsSync(previousCapturePath), true);

      const activeCapture = JSON.parse(readFileSync(lastCapturePath, 'utf8')) as CapturedFixture;
      assert.equal(activeCapture.events.length, 0);

      const postEvents = await runPyricJson(app, ['sandbox', 'events', '--limit', '50']);
      const postEventList = (postEvents.data as { events: unknown[] }).events;
      assert.equal(postEventList.length, 0);

      const namedAfter = await runPyricJson(app, [
        'database',
        'get',
        '--instance',
        'alt-db',
        '--path',
        'nodes/n1',
      ]);
      assert.equal((namedAfter.data as { exists: boolean }).exists, false);
    });

    await app.step('session capture snapshots live updated Firestore, RTDB, and Storage rules', async () => {
      const setFs = await runPyricJson(app, [
        'rules',
        'set',
        '--service',
        'firestore',
        '--rules',
        UPDATED_FIRESTORE_RULES,
      ]);
      assert.equal(setFs.ok, true);

      const setRtdb = await runPyricJson(app, [
        'rules',
        'set',
        '--service',
        'database',
        '--rules',
        JSON.stringify(UPDATED_RTDB_RULES),
      ]);
      assert.equal(setRtdb.ok, true);

      const setStorage = await runPyricJson(app, [
        'rules',
        'set',
        '--service',
        'storage',
        '--rules',
        UPDATED_STORAGE_RULES,
      ]);
      assert.equal(setStorage.ok, true);

      const writeDoc = await callHosted(pointer, projectDir, 'firestore.setDoc', {
        path: 'items/i1',
        data: { label: 'live' },
      });
      assert.equal(writeDoc.ok, true);

      const writeRtdb = await callHosted(pointer, projectDir, 'database.set', {
        path: 'nodes/n1',
        value: { live: true },
      });
      assert.equal(writeRtdb.ok, true);

      const uploadObj = await callHosted(pointer, projectDir, 'storage.uploadBytes', {
        path: 'files/hello.txt',
        contentBase64: Buffer.from('hello').toString('base64'),
      });
      assert.equal(uploadObj.ok, true, uploadObj.summary);

      const resetRes = await runPyricJson(app, ['sandbox', 'reset', '--confirm']);
      assert.equal(resetRes.ok, true);

      const preserved = JSON.parse(readFileSync(previousCapturePath, 'utf8')) as CapturedFixture;
      assert.equal(preserved.services.firestore?.rules.source, UPDATED_FIRESTORE_RULES);
      assert.deepEqual(preserved.services.rtdb?.rules.json, UPDATED_RTDB_RULES);
      assert.equal(preserved.services.storage?.rules.source, UPDATED_STORAGE_RULES);
    });

    await app.step('sandbox.activity since slicing is strictly exclusive across Firestore and RTDB', async () => {
      const seedRes = await callHosted(pointer, projectDir, 'firestore.setDoc', {
        path: 'items/hot',
        data: { count: 1 },
      });
      assert.equal(seedRes.ok, true);

      const appReadsScript = join(projectDir, 'app-reads.mjs');
      writeFileSync(
        appReadsScript,
        [
          "import { initializeApp } from 'firebase/app';",
          "import { doc, getDoc, getFirestore } from 'firebase/firestore';",
          "const fbApp = initializeApp({ projectId: 'demo-app' });",
          'const db = getFirestore(fbApp);',
          'for (let i = 0; i < 8; i += 1) {',
          "  await getDoc(doc(db, 'items/hot'));",
          '}',
          'process.exit(0);',
        ].join('\n'),
      );
      const runReads = await app.pyric([
        'run',
        '--sandbox',
        pointer.url,
        '--',
        'node',
        appReadsScript,
      ]);
      assert.equal(runReads.code, 0, runReads.output);

      const fullActivity = await callHosted(pointer, projectDir, 'sandbox.activity', {});
      assert.equal(fullActivity.ok, true);
      const fullData = fullActivity.data as { incidents: Array<{ pattern: string }> };
      assert.ok(fullData.incidents.some((incident) => incident.pattern === 'repeated-read'));

      const fsEvents = await callHosted(pointer, projectDir, 'sandbox.events', { limit: 100 });
      const fsList = (fsEvents.data as { events: Array<{ id: string }> }).events;
      const lastFsId = fsList.at(-1)?.id;
      assert.ok(lastFsId);

      const afterFs = await callHosted(pointer, projectDir, 'sandbox.activity', { since: lastFsId });
      assert.equal(afterFs.ok, true);
      const afterFsData = afterFs.data as { incidents: unknown[]; notExamined: unknown[] };
      assert.equal(afterFsData.incidents.length, 0);
      assert.equal(afterFsData.notExamined.length, 0);

      const rtdbWrite = await callHosted(pointer, projectDir, 'database.set', {
        path: 'nodes/n1',
        value: { count: 2 },
      });
      assert.equal(rtdbWrite.ok, true);

      const rtdbEvents = await callHosted(pointer, projectDir, 'sandbox.events', { limit: 100 });
      const rtdbList = (rtdbEvents.data as { events: Array<{ id: string }> }).events;
      const lastRtdbId = rtdbList.at(-1)?.id;
      assert.ok(lastRtdbId);

      const afterRtdb = await callHosted(pointer, projectDir, 'sandbox.activity', {
        since: lastRtdbId,
      });
      assert.equal(afterRtdb.ok, true);
      const afterRtdbData = afterRtdb.data as { incidents: unknown[]; notExamined: unknown[] };
      assert.equal(afterRtdbData.incidents.length, 0);
      assert.equal(afterRtdbData.notExamined.length, 0);
    });

    await app.step('sandbox.events preserves observation_gap after bounded denial eviction', async () => {
      const resetBeforeEviction = await runPyricJson(app, ['sandbox', 'reset', '--confirm']);
      assert.equal(resetBeforeEviction.ok, true);

      const setDeny = await runPyricJson(app, [
        'rules',
        'set',
        '--service',
        'firestore',
        '--rules',
        DENY_FIRESTORE_RULES,
      ]);
      assert.equal(setDeny.ok, true);

      const actAsUser = await callHosted(pointer, projectDir, 'auth.impersonate', { uid: 'user-1' });
      assert.equal(actAsUser.ok, true);

      const largePayload = 'x'.repeat(200_000);
      for (let i = 0; i < 25; i += 1) {
        const denied = await callHosted(pointer, projectDir, 'firestore.setDoc', {
          path: `items/denied-${i}`,
          data: { payload: largePayload, index: i },
        });
        assert.equal(denied.ok, false);
      }

      const eventsRes = await callHosted(pointer, projectDir, 'sandbox.events', {
        kind: 'denials',
        limit: 500,
      });
      assert.equal(eventsRes.ok, true);
      const eventsList = (eventsRes.data as { events: Array<Record<string, unknown>> }).events;
      const gap = eventsList.find((entry) => entry.kind === 'observation_gap');
      assert.ok(gap, `expected observation_gap in sandbox.events, summary="${eventsRes.summary}"`);
      assert.equal(gap.reason, 'history-limit');
      assert.ok(typeof gap.omittedCount === 'number' && gap.omittedCount > 0);
      assert.ok(typeof gap.omittedDenials === 'number' && gap.omittedDenials > 0);
    });
  } finally {
    await host.stop();
  }
});
