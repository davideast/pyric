/**
 * End-to-end Live Mode scenario for observed-session local rules evaluation and
 * Studio Traffic Inspector UX (#2540):
 *
 * 1. Partial deep child write (`groups/g-1/config/plan = "pro"`) materializes
 *    the `groups/g-1/config` object in `observedSession` without covering
 *    sibling `groups/g-1/config/archived`. A subsequent read on
 *    `groups/g-1/items/item-1` (whose rule checks
 *    `!root.child('groups/' + $groupId + '/config/archived').exists()`) does
 *    NOT fail open: the host records `result: 'unevaluated'` with
 *    `missingPaths: ['/groups/g-1/config/archived']`, and Studio renders
 *    `Matched rule — paused on uncaptured path /groups/g-1/config/archived`.
 * 2. Reading the full `groups/g-1/config` subtree establishes authoritative
 *    coverage (confirming `archived` is absent), so the next write to
 *    `groups/g-1/items/item-1` evaluates locally to `result: 'allow'`, and
 *    reading an item under `groups/g-archived` (`archived: true`) evaluates
 *    locally to `result: 'deny'` with `drift: true`.
 * 3. Standalone `?inspect=<id>` details in Live Mode render with a collapsible
 *    `<TrafficRow>` summary header above `<LiveRowDetail>` that collapses on
 *    click, and switching Traffic subtabs or clicking top-level `Traffic`
 *    clears stale `?inspect=<id>` while preserving `?hide=studio`.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-observed-rules';
const DEFAULT_INSTANCE = `${PROJECT}-default-rtdb`;
const RECORDING = 'recording.json';
const STUDIO_FONT_HOSTS = /\bhttps:\/\/(?:use\.typekit\.net|fonts\.googleapis\.com)\//;

declare function runApp(): Promise<unknown>;

interface CapturedEvent {
  id?: string;
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  production?: {
    local?: {
      result?: string;
      drift?: boolean;
      needs?: string[];
      missingPaths?: string[];
    };
  };
}

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /groups/{groupId} {
      allow read: if request.auth != null;
      match /notes/{noteId} {
        allow read: if request.auth != null
          && request.auth.uid in get(/databases/$(database)/documents/groups/$(groupId)).data.members;
      }
    }
  }
}
`;

const DATABASE_RULES = {
  rules: {
    '.read': false,
    '.write': false,
    groups: {
      $groupId: {
        config: {
          '.read':
            "auth != null && root.child('groups/' + $groupId + '/members/' + auth.uid).val() === true",
          plan: {
            '.write': 'auth != null',
          },
        },
        members: {
          $uid: {
            '.write': 'auth != null && auth.uid === $uid',
          },
        },
        items: {
          $itemId: {
            '.read':
              "auth != null && root.child('groups/' + $groupId + '/members/' + auth.uid).val() === true && !root.child('groups/' + $groupId + '/config/archived').exists()",
            '.write':
              "auth != null && root.child('groups/' + $groupId + '/members/' + auth.uid).val() === true && !root.child('groups/' + $groupId + '/config/archived').exists()",
          },
        },
      },
    },
  },
};

function firestoreDocListen(id: string, uid: string, relPath: string, fields: Record<string, unknown>) {
  const fullName = `projects/${PROJECT}/databases/(default)/documents/${relPath}`;
  return {
    kind: 'listen',
    id,
    as: uid,
    target: { documents: { documents: [fullName] } },
    batches: [
      {
        messages: [
          { targetChange: { targetChangeType: 'ADD', targetIds: [{ $: 'targetId' }] } },
          {
            documentChange: {
              document: {
                name: fullName,
                fields,
                createTime: '2026-11-01T08:00:00.000000Z',
                updateTime: '2026-11-01T08:00:00.000000Z',
              },
              targetIds: [{ $: 'targetId' }],
            },
          },
          {
            targetChange: {
              targetChangeType: 'CURRENT',
              targetIds: [{ $: 'targetId' }],
              resumeToken: { $: 'resumeToken' },
              readTime: { $: 'readTime' },
            },
          },
        ],
      },
    ],
  };
}

function buildRecording(format: string): Record<string, unknown> {
  const uid = 'user-1';
  return {
    format,
    project: PROJECT,
    source: 'synthetic Firestore + RTDB + Auth v1 wire exchanges for #2540',
    exchanges: [
      {
        kind: 'auth',
        id: 'sign-in-1',
        request: {
          method: 'POST',
          host: 'identitytoolkit.googleapis.com',
          path: '/v1/accounts:signInWithCustomToken',
          body: { token: 'client-1', returnSecureToken: true },
        },
        response: {
          status: 200,
          body: {
            kind: 'identitytoolkit#VerifyCustomTokenResponse',
            idToken: { $: 'idToken', uid, provider: 'anonymous' },
            refreshToken: { $: 'refreshToken' },
            expiresIn: '3600',
            isNewUser: true,
          },
        },
      },
      {
        kind: 'auth',
        id: 'lookup-1',
        request: {
          method: 'POST',
          host: 'identitytoolkit.googleapis.com',
          path: '/v1/accounts:lookup',
          body: { idToken: { $: 'idToken', uid } },
        },
        response: {
          status: 200,
          body: {
            kind: 'identitytoolkit#GetAccountInfoResponse',
            users: [{ localId: uid, lastLoginAt: '1793907850000', createdAt: '1793907850000' }],
          },
        },
      },
      firestoreDocListen('fs-note-1', uid, 'groups/g-1/notes/note-1', {
        body: { stringValue: 'First note' },
      }),
      firestoreDocListen('fs-group-1', uid, 'groups/g-1', {
        members: { arrayValue: { values: [{ stringValue: uid }] } },
      }),
      firestoreDocListen('fs-note-2', uid, 'groups/g-1/notes/note-2', {
        body: { stringValue: 'Second note' },
      }),
      {
        kind: 'rtdb',
        id: 'handshake-1',
        instance: DEFAULT_INSTANCE,
        events: [
          {
            t: 'c',
            d: {
              t: 'h',
              d: {
                ts: { $: 'serverTime' },
                v: '5',
                h: { $: 'host' },
                s: { $: 'session' },
              },
            },
          },
        ],
      },
      {
        kind: 'rtdb',
        id: 'set-member',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'p', b: { p: '/groups/g-1/members/user-1', d: true } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'set-config-plan',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'p', b: { p: '/groups/g-1/config/plan', d: 'pro' } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'get-item-partial',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'g', b: { p: '/groups/g-1/items/item-1', q: {} } },
        reply: { s: 'ok', d: { title: 'Draft' } },
      },
      {
        kind: 'rtdb',
        id: 'get-config-full',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'g', b: { p: '/groups/g-1/config', q: {} } },
        reply: { s: 'ok', d: { plan: 'pro' } },
      },
      {
        kind: 'rtdb',
        id: 'set-item-covered',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'p', b: { p: '/groups/g-1/items/item-1', d: { title: 'Approved' } } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'set-archived-member',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'p', b: { p: '/groups/g-archived/members/user-1', d: true } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'get-config-archived',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'g', b: { p: '/groups/g-archived/config', q: {} } },
        reply: { s: 'ok', d: { plan: 'pro', archived: true } },
      },
      {
        kind: 'rtdb',
        id: 'get-item-archived-drift',
        instance: DEFAULT_INSTANCE,
        as: uid,
        request: { a: 'g', b: { p: '/groups/g-archived/items/item-2', q: {} } },
        reply: { s: 'ok', d: { title: 'Legacy' } },
      },
    ],
  };
}

function isLongPollStart(entry: unknown): boolean {
  const { rpc, request } = entry as { rpc?: string; request?: { method?: string; path?: string } };
  return rpc === 'http' && request?.method === 'GET' && (request.path ?? '').startsWith('/.lp?start=t&');
}

async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: still ${JSON.stringify(value, null, 1)} after ${timeoutMs / 1000}s`);
    }
    await sleep(200);
  }
}

function operationEvents(app: App, service: 'rtdb' | 'firestore'): CapturedEvent[] {
  try {
    const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
    return (capture.events ?? []).filter((ev) => ev.kind === 'operation' && ev.service === service);
  } catch {
    return [];
  }
}

function findEvent(events: CapturedEvent[], method: string, path: string): CapturedEvent {
  const found = events.find(
    (ev) => ev.method === method && ev.path?.replace(/^\/?/, '/') === path.replace(/^\/?/, '/'),
  );
  assert.ok(found?.id, `expected ${method} ${path} in ${JSON.stringify(events, null, 1)}`);
  return found;
}

async function studioUrlSearch(studio: Page): Promise<string> {
  return studio.evaluate(() => window.location.pathname + window.location.search);
}

export default scenario(async (app) => {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firestore.rules', FIRESTORE_RULES);
  app.writeFile('database.rules.json', `${JSON.stringify(DATABASE_RULES, null, 2)}\n`);
  app.writeFile(
    'firebase.json',
    `${JSON.stringify({
      hosting: { public: 'public' },
      firestore: { rules: 'firestore.rules' },
      database: { rules: 'database.rules.json' },
    })}\n`,
  );
  app.writeFile(RECORDING, `${JSON.stringify(buildRecording(FORMAT))}\n`);

  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const replay = app.commandProcess('node', replayServerArgs([`${app.dir}/${RECORDING}`]));
  await replay.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(replay.output);
  assert.ok(endpoints, `replay server printed no origin:\n${replay.output}`);

  const host = await app.step('start vite dev with pyricLive()', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(
      new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`),
    );
    return started;
  });

  const page = await app.step('run partial-then-full Firestore and RTDB observation sequence in browser', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(endpoints.origin)}`);
    await eventually(
      () => opened.evaluate(() => document.querySelector('#status')?.textContent ?? ''),
      (text) => text === 'Ready',
      'client ready',
    );
    const outcome = await opened.evaluate(() => runApp());
    assert.deepEqual(outcome, {
      uid: 'user-1',
      initialNote: { body: 'First note' },
      groupDoc: { members: ['user-1'] },
      coveredNote: { body: 'Second note' },
      initialItem: { title: 'Draft' },
      groupConfig: { plan: 'pro' },
      archivedConfig: { plan: 'pro', archived: true },
      archivedItem: { title: 'Legacy' },
    });
    const unmatched = (await unmatchedBy(endpoints.origin)).filter((e) => !isLongPollStart(e));
    assert.deepEqual(unmatched, []);
    return opened;
  });

  const events = await app.step('verify fail-closed missingPaths and decided allow/deny local verdicts on host stream', async () => {
    const fsCaptured = await eventually(
      async () => operationEvents(app, 'firestore'),
      (all) => all.length >= 3,
      'all 3 Firestore events captured',
    );
    const initialNoteGet = findEvent(fsCaptured, 'getDoc', 'groups/g-1/notes/note-1');
    assert.equal(initialNoteGet.production?.local?.result, 'unevaluated');
    assert.deepEqual(initialNoteGet.production?.local?.needs, ['stored-document']);
    assert.deepEqual(initialNoteGet.production?.local?.missingPaths, ['groups/g-1']);

    const coveredNoteGet = findEvent(fsCaptured, 'getDoc', 'groups/g-1/notes/note-2');
    assert.equal(coveredNoteGet.production?.local?.result, 'allow');

    const captured = await eventually(
      async () => operationEvents(app, 'rtdb'),
      (all) => all.length >= 8,
      'all 8 RTDB events captured',
    );
    const partialGet = findEvent(captured, 'get', '/groups/g-1/items/item-1');
    assert.equal(partialGet.production?.local?.result, 'unevaluated');
    assert.deepEqual(partialGet.production?.local?.needs, ['stored-document']);
    assert.deepEqual(partialGet.production?.local?.missingPaths, ['/groups/g-1/config/archived']);

    const fullConfigGet = findEvent(captured, 'get', '/groups/g-1/config');
    assert.equal(fullConfigGet.production?.local?.result, 'allow');

    const coveredSet = findEvent(captured, 'set', '/groups/g-1/items/item-1');
    assert.equal(coveredSet.production?.local?.result, 'allow');

    const archivedItemGet = findEvent(captured, 'get', '/groups/g-archived/items/item-2');
    assert.equal(archivedItemGet.production?.local?.result, 'deny');
    assert.equal(archivedItemGet.production?.local?.drift, true);
    return { partialGet, coveredSet, archivedItemGet };
  });

  await app.step('verify Studio paused-on-uncaptured-path inspector, collapsible StandaloneDetail, and ?inspect clearing', async () => {
    const studio = await app.page(
      `${host.url}/__pyric/ui/traffic/?inspect=${encodeURIComponent(events.partialGet.id!)}&hide=studio`,
    );
    const pausedInspector = studio.locator(
      '[data-pyric-ui="traffic-live-rules-inspector"][data-live-unevaluated]',
    );
    await pausedInspector.waitFor({ timeout: 30_000 });
    const pausedText = (await pausedInspector.textContent()) ?? '';
    assert.match(pausedText, /Matched rule — paused on uncaptured path \/groups\/g-1\/config\/archived/);
    assert.equal(
      await pausedInspector.locator('[data-missing-path="/groups/g-1/config/archived"]').count(),
      1,
    );

    // Filter the visible table rows so the inspected live row renders via TrafficStandaloneDetail!
    await studio.locator('[aria-label="Traffic filters"] button', { hasText: /^allow$/i }).click();
    const standalone = studio.locator('[data-pyric-ui="traffic-standalone-detail"]');
    await standalone.waitFor({ timeout: 10_000 });
    const standaloneRow = standalone.locator('[data-pyric-traffic-row]');
    assert.equal(await standaloneRow.getAttribute('aria-expanded'), 'true');
    assert.match((await standaloneRow.textContent()) ?? '', /\/groups\/g-1\/items\/item-1/);

    // Clicking the collapsible <TrafficRow> header at the top collapses ?inspect= while preserving ?hide=studio!
    await standaloneRow.click();
    await eventually(
      () => studioUrlSearch(studio),
      (url) => !url.includes('inspect=') && url.includes('hide=studio'),
      'clicking standalone TrafficRow collapses ?inspect=',
    );
    assert.equal(await standalone.count(), 0);

    // Restore 'all' verdict filter and open decided allow row (`coveredSet`).
    await studio.locator('[aria-label="Traffic filters"] button', { hasText: /^all$/i }).click();
    await studio
      .locator(`[data-pyric-traffic-id="${events.coveredSet.id!}"] [data-pyric-traffic-row]`)
      .click();
    const decidedInspector = studio.locator('[data-pyric-ui="traffic-live-rules-inspector"]');
    await decidedInspector.waitFor({ timeout: 15_000 });
    assert.equal(
      await decidedInspector.locator('[data-pyric-badge-kind="allow"]').textContent(),
      'local rules would allow',
    );

    // Switching Traffic subtabs clears stale ?inspect= while preserving ?hide=studio!
    await studio.locator('[role="tab"]', { hasText: 'Billable metrics' }).click();
    await eventually(
      () => studioUrlSearch(studio),
      (url) => url.includes('view=billable') && !url.includes('inspect=') && url.includes('hide=studio'),
      'switching subtab clears ?inspect=',
    );
    await studio.locator('[role="tab"]', { hasText: 'Timeline' }).click();
    await eventually(
      () => studioUrlSearch(studio),
      (url) => !url.includes('view=') && !url.includes('inspect=') && url.includes('hide=studio'),
      'returning to Timeline keeps ?inspect= cleared',
    );

    // Re-open archived drift row, then click top-level Traffic in the Studio rail -> clears ?inspect=!
    await studio
      .locator(`[data-pyric-traffic-id="${events.archivedItemGet.id!}"] [data-pyric-traffic-row]`)
      .click();
    await eventually(
      () => studioUrlSearch(studio),
      (url) => url.includes(`inspect=${events.archivedItemGet.id!}`),
      'opened archived drift row',
    );
    assert.equal(
      await studio.locator('[data-pyric-ui="traffic-row-detail"] [data-drift-reason]').count(),
      1,
    );
    await studio.locator('.studio__rail a', { hasText: /^Traffic$/ }).click();
    await eventually(
      () => studioUrlSearch(studio),
      (url) => !url.includes('inspect=') && url.includes('hide=studio'),
      'clicking top-level Traffic clears ?inspect= while preserving ?hide=studio',
    );

    await studio.close();
  });

  const externalBlocked = app.browserLog
    .filter((line) => line.includes('[blocked external'))
    .filter((line) => !STUDIO_FONT_HOSTS.test(line));
  assert.deepEqual(externalBlocked, []);

  await page.close();
  await host.process.stop();
  await replay.stop();
});
