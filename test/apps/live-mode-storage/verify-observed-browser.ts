import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Page } from 'playwright';
import { sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-storage';
const DEFAULT_BUCKET = `${PROJECT}.firebasestorage.app`;
const SECOND_BUCKET = `${PROJECT}-live-second`;
const CATALOG_FIXTURE = 'browser-catalog.json';

const NODE_MAJOR = Number(
  spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim().split('.')[0],
);
const ADMIN_ROWS_SUPPORTED = NODE_MAJOR >= 23;

declare function seedCatalogFromPage(replayOrigin: string): Promise<string>;

function buildCatalogRecording(format: string): Record<string, unknown> {
  const coverBody = {
    name: 'workspaces/ws-1/items/cover.png',
    bucket: DEFAULT_BUCKET,
    generation: { $: 'generation' },
    metageneration: '1',
    contentType: 'image/png',
    timeCreated: { $: 'timeCreated' },
    updated: { $: 'timeCreated' },
    storageClass: 'STANDARD',
    size: '6',
    md5Hash: 'asHla8ePAxBZvnvoVFIsTA==',
    cacheControl: 'public, max-age=3600',
    metadata: {
      owner: 'user-1',
      firebaseStorageDownloadTokens: 'secret-download-tok',
      webhookSecret: 'whsec_123',
    },
    downloadTokens: { $: 'downloadToken' },
  };

  const reportBody = {
    kind: 'storage#object',
    id: `${SECOND_BUCKET}/exports/monthly/report.json/1793520000000000`,
    name: 'exports/monthly/report.json',
    bucket: SECOND_BUCKET,
    generation: '1793520000000000',
    metageneration: '2',
    contentType: 'application/json',
    storageClass: 'STANDARD',
    size: '12',
    md5Hash: 'xgQX3hTxD8e0kVuo9iMlIg==',
    crc32c: 'HVmdqA==',
    etag: 'replay-etag',
    timeCreated: '2026-11-01T08:00:00.000Z',
    updated: '2026-11-01T08:01:00.000Z',
    metadata: {
      generatedBy: 'worker',
      apiKey: 'sk-secret-999',
    },
  };

  const clientFallbackReportBody = {
    ...reportBody,
    generation: { $: 'generation' },
    timeCreated: { $: 'timeCreated' },
    updated: { $: 'timeCreated' },
  };

  return {
    format,
    project: PROJECT,
    source: 'synthetic catalog exchanges for live-mode observed Storage browser verification',
    exchanges: [
      {
        kind: 'auth',
        id: 'catalog-sign-in-1',
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
            idToken: { $: 'idToken', uid: 'user-1', provider: 'anonymous' },
            refreshToken: { $: 'refreshToken' },
            expiresIn: '3600',
            isNewUser: false,
          },
        },
      },
      {
        kind: 'auth',
        id: 'catalog-lookup-1',
        request: {
          method: 'POST',
          host: 'identitytoolkit.googleapis.com',
          path: '/v1/accounts:lookup',
          body: { idToken: { $: 'idToken', uid: 'user-1' } },
        },
        response: {
          status: 200,
          body: {
            kind: 'identitytoolkit#GetAccountInfoResponse',
            users: [{ localId: 'user-1', lastLoginAt: '1793937599013', createdAt: '1793937599013' }],
          },
        },
      },
      {
        kind: 'storage',
        id: 'catalog-client-upload',
        as: 'user-1',
        request: {
          method: 'POST',
          bucket: DEFAULT_BUCKET,
          query: { name: 'workspaces/ws-1/items/cover.png' },
          upload: { protocol: 'multipart' },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: coverBody,
        },
      },
      {
        kind: 'storage',
        id: 'catalog-client-download-url',
        as: 'user-1',
        request: {
          method: 'GET',
          bucket: DEFAULT_BUCKET,
          object: 'workspaces/ws-1/items/cover.png',
          query: {},
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: coverBody,
        },
      },
      {
        kind: 'admin-storage',
        id: 'catalog-admin-save',
        request: {
          method: 'POST',
          path: `/upload/storage/v1/b/${SECOND_BUCKET}/o`,
          query: { uploadType: 'multipart', name: 'exports/monthly/report.json' },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: reportBody,
        },
      },
      {
        kind: 'admin-storage',
        id: 'catalog-admin-set-metadata',
        request: {
          method: 'PATCH',
          path: `/b/${SECOND_BUCKET}/o/exports%2Fmonthly%2Freport.json`,
          query: {},
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: reportBody,
        },
      },
      {
        kind: 'storage',
        id: 'catalog-fallback-upload',
        as: 'user-1',
        request: {
          method: 'POST',
          bucket: SECOND_BUCKET,
          query: { name: 'exports/monthly/report.json' },
          upload: { protocol: 'multipart' },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: clientFallbackReportBody,
        },
      },
      {
        kind: 'storage',
        id: 'catalog-fallback-get-metadata',
        as: 'user-1',
        request: {
          method: 'GET',
          bucket: SECOND_BUCKET,
          object: 'exports/monthly/report.json',
          query: {},
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: clientFallbackReportBody,
        },
      },
    ],
  };
}

async function pollUntil<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out after ${timeoutMs / 1000}s: ${JSON.stringify(value)}`);
    }
    await sleep(200);
  }
}

export async function verifyObservedStorageBrowser(
  app: App,
  hostUrl: string,
  appPage: Page,
): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');

  app.writeFile(CATALOG_FIXTURE, `${JSON.stringify(buildCatalogRecording(FORMAT))}\n`);
  const replay = app.commandProcess('node', replayServerArgs([`${app.dir}/${CATALOG_FIXTURE}`]));
  await replay.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(replay.output);
  assert.ok(endpoints, `catalog replay server named no origin:\n${replay.output}`);

  try {
    const observedDownloadUrl = await appPage.evaluate(
      (origin) => seedCatalogFromPage(origin),
      endpoints.origin,
    );
    assert.ok(observedDownloadUrl.startsWith(endpoints.origin), observedDownloadUrl);
    const parsedRawUrl = new URL(observedDownloadUrl);
    const rawDownloadToken = parsedRawUrl.searchParams.get('token');
    assert.ok(rawDownloadToken && rawDownloadToken.length > 0, `expected raw SDK token in ${observedDownloadUrl}`);

    const seedMode = ADMIN_ROWS_SUPPORTED ? 'admin' : 'client-fallback';
    const seedRun = await app.command(
      'node',
      ['--import', '@pyric/live/register', 'admin-seed.mjs'],
      {
        env: {
          SEED_MODE: seedMode,
          STORAGE_EMULATOR_HOST: endpoints.origin,
        },
        timeoutMs: 60_000,
      },
    );
    assert.equal(seedRun.code, 0, seedRun.output);
    assert.deepEqual(await unmatchedBy(endpoints.origin), []);

    // Wait for both buckets to appear in `/__pyric/live/session-data`.
    const sessionRaw = await pollUntil(
      async () => (await fetch(`${hostUrl}/__pyric/live/session-data`)).text(),
      (text) => {
        const parsed = JSON.parse(text) as {
          storage?: Record<string, { objects?: Record<string, unknown> }>;
        };
        const hasDefault = Boolean(
          parsed.storage?.[DEFAULT_BUCKET]?.objects?.['workspaces/ws-1/items/cover.png'],
        );
        const hasSecond = Boolean(
          parsed.storage?.[SECOND_BUCKET]?.objects?.['exports/monthly/report.json'],
        );
        return hasDefault && hasSecond;
      },
      'observed Storage session catalog across both buckets',
    );

    // Zero raw payload bytes in host RAM or `.pyric/`, while preserving verbatim metadata and download URLs.
    assert.equal(
      sessionRaw.includes('{"ok":true}'),
      false,
      `session-data leaked raw object bytes: ${sessionRaw}`,
    );
    for (const expectedMetadataValue of [
      'secret-download-tok',
      'whsec_123',
      'sk-secret-999',
      rawDownloadToken,
    ]) {
      assert.equal(
        sessionRaw.includes(expectedMetadataValue),
        true,
        `session-data should preserve "${expectedMetadataValue}" verbatim: ${sessionRaw}`,
      );
    }
    const diskCapture = app.readFile('.pyric/last-session.json');
    assert.equal(
      diskCapture.includes('{"ok":true}'),
      false,
      '.pyric/last-session.json leaked raw object bytes',
    );

    const context = await app.browser();
    const fontHosts = /^https:\/\/(use\.typekit\.net|fonts\.googleapis\.com)\//;
    await context.route(fontHosts, (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );

    try {
      const studio = await app.page(`${hostUrl}/__pyric/ui/storage`);
      await studio.locator('[data-pyric-ui="storage-live-observed"]').waitFor({ timeout: 30_000 });
      assert.equal(
        await studio.locator('[data-pyric-ui="live-service-unavailable"]').count(),
        0,
        'Storage in Live mode must render the Observed Storage browser instead of LiveServiceUnavailable',
      );
      // Zero write controls in Live mode.
      assert.equal(await studio.locator('input[type="file"]').count(), 0);
      assert.equal(await studio.locator('input[type="checkbox"]').count(), 0);
      const paneText = (await studio.locator('[data-pyric-ui="storage-live-observed"]').textContent()) ?? '';
      assert.equal(paneText.includes('Upload files'), false);
      assert.equal(paneText.includes('New folder'), false);

      // Root of default bucket shows session delete tombstones from earlier deleteObject calls.
      await studio.locator('[data-live-storage-deleted-tombstones]').waitFor({ timeout: 15_000 });

      // Navigate `workspaces` -> `ws-1` -> `items` -> `cover.png` on the default bucket.
      await studio.locator('[data-pyric-entry-path="workspaces"] [data-pyric-entry-select]').click();
      await studio.locator('[data-pyric-entry-path="workspaces/ws-1"] [data-pyric-entry-select]').click();
      await studio
        .locator('[data-pyric-entry-path="workspaces/ws-1/items"] [data-pyric-entry-select]')
        .click();
      await studio
        .locator('[data-pyric-entry-path="workspaces/ws-1/items/cover.png"] [data-pyric-entry-select]')
        .click();

      await studio.locator('[data-live-storage-no-bytes]').waitFor({ timeout: 15_000 });
      assert.match(
        (await studio.locator('[data-live-storage-no-bytes]').textContent()) ?? '',
        /Object bytes are not buffered in Live mode/,
      );
      assert.equal(await studio.locator('[data-live-storage-credentials-stripped]').count(), 0);
      assert.equal(await studio.locator('[data-live-storage-copy-gs-uri]').count(), 1);
      assert.equal(await studio.locator('[data-live-storage-copy-path]').count(), 1);
      assert.equal(
        await studio.locator('[data-live-storage-download-url]').getAttribute('href'),
        observedDownloadUrl,
      );
      assert.equal(
        await studio.locator('[data-pyric-metadata-field="contentType"] dd').textContent(),
        'image/png',
      );
      assert.equal(
        await studio.locator('[data-pyric-metadata-key="owner"] dd').textContent(),
        'user-1',
      );
      assert.equal(
        await studio
          .locator('[data-pyric-metadata-key="firebaseStorageDownloadTokens"] dd')
          .textContent(),
        'secret-download-tok',
      );
      assert.equal(
        await studio.locator('[data-pyric-metadata-key="webhookSecret"] dd').textContent(),
        'whsec_123',
      );

      // Switch to the second bucket and inspect the server-seeded `exports/monthly/report.json`.
      await studio.locator(`[data-storage-bucket="${SECOND_BUCKET}"]`).click();
      await studio.locator('[data-pyric-entry-path="exports"] [data-pyric-entry-select]').click();
      await studio
        .locator('[data-pyric-entry-path="exports/monthly"] [data-pyric-entry-select]')
        .click();
      await studio
        .locator('[data-pyric-entry-path="exports/monthly/report.json"] [data-pyric-entry-select]')
        .click();

      await studio.locator('[data-pyric-metadata-key="apiKey"]').waitFor({ timeout: 15_000 });
      assert.equal(
        await studio.locator('[data-pyric-metadata-field="contentType"] dd').textContent(),
        'application/json',
      );
      assert.equal(
        await studio.locator('[data-pyric-metadata-key="generatedBy"] dd').textContent(),
        'worker',
      );
      assert.equal(
        await studio.locator('[data-pyric-metadata-key="apiKey"] dd').textContent(),
        'sk-secret-999',
      );
      assert.equal(await studio.locator('[data-live-storage-download-url]').count(), 0);

      // Verify `/__pyric/ui/auth` remains gated behind `LiveServiceUnavailable`.
      await studio.goto(`${hostUrl}/__pyric/ui/auth`);
      await studio.locator('[data-pyric-ui="live-service-unavailable"]').waitFor({ timeout: 30_000 });
      assert.match(
        (await studio.locator('[data-pyric-ui="live-service-unavailable"]').textContent()) ?? '',
        /Auth user listing is unavailable in Live mode/,
      );

      await studio.close();
    } finally {
      await context.unroute(fontHosts);
    }
  } finally {
    await replay.stop();
  }
}
