/**
 * Playground deploy proof. Exercises the full chain end-to-end against
 * the digame-mas project:
 *
 *   1. Mint a `cloud-platform` SA token (server side).
 *   2. Fetch the project's default web config (server side).
 *   3. Boot the playground with the token + seed planted via the
 *      DEV-only test hatches in `lib/auth/gis-token.ts` and
 *      `lib/store/workspace.ts`.
 *   4. Switch to the Deploy tab, click "Deploy to Firebase".
 *   5. Assert each StepRow flips to ✓ (preflight → rules → hosting →
 *      indexes).
 *   6. Capture the hosting URL from the Hosting row.
 *   7. Wait for "All N indexes ready" in the build-progress section.
 *   8. Seed one document via Firestore REST (SA bypasses rules).
 *   9. Open the live URL and assert `data-testid="proof-rows"` reads
 *      "1 proof row".
 *
 * Time budget: ~5min total (indexes dominate). Configured timeouts in
 * `playwright.config.ts`.
 */
import { test, expect, type Page } from '@playwright/test';

import { HELLO_WORLD_APP, HELLO_WORLD_RULES } from './fixtures';
import { fetchWebConfig } from './helpers/fetchWebConfig';
import { mintSaToken, PROOF_PROJECT_ID, PROOF_SITE_ID } from './helpers/saToken';
import { seedProofDoc } from './helpers/seedProof';

let saToken: string;
let webConfig: Awaited<ReturnType<typeof fetchWebConfig>>;

test.beforeAll(async () => {
  saToken = await mintSaToken();
  webConfig = await fetchWebConfig(PROOF_PROJECT_ID, saToken);
});

test('deploy proof — fixture app ships to digame-mas', async ({ browser }) => {
  const context = await browser.newContext();
  // Plant the test token before any page script runs.
  await context.addInitScript((token) => {
    (window as unknown as { __pyricTestToken: string }).__pyricTestToken = token;
  }, saToken);

  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // `/` is the home/session-picker. PlaygroundPage (with the Deploy
  // tab) lives at `/playground?session=<id>`. Drive the home form to
  // create a session, then wait for the playground UI to hydrate
  // before seeding — `useSessionRouting`'s `applyPayload` runs on
  // mount and would otherwise clobber the seed with the loaded
  // session's empty workspace.
  await page.goto('/');
  await page.locator('textarea').fill('deploy proof');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.waitForURL(/\/playground/, { timeout: 30_000 });

  // The Deploy tab button only renders once `sessionRouting.loaded`
  // flips true (PlaygroundPage shows a "Loading session…" placeholder
  // until then). Its presence is the hydration-done signal we use to
  // gate the seed call.
  const deployTab = page.getByRole('button', { name: 'Deploy', exact: true });
  await deployTab.waitFor({ state: 'visible', timeout: 30_000 });

  // The seed setter is installed by the workspace store module, which
  // is imported eagerly by the playground page bundle.
  await page.waitForFunction(() => typeof window.__pyricTestSeed === 'function', null, {
    timeout: 10_000,
  });

  await page.evaluate(
    ({ appSource, rules, deployTarget }) => {
      window.__pyricTestSeed!({ appSource, rules, deployTarget });
    },
    {
      appSource: HELLO_WORLD_APP,
      rules: HELLO_WORLD_RULES,
      deployTarget: {
        projectId: PROOF_PROJECT_ID,
        siteId: PROOF_SITE_ID,
        firebaseConfig: {
          apiKey: webConfig.apiKey,
          authDomain: webConfig.authDomain,
          projectId: webConfig.projectId,
          ...(webConfig.appId ? { appId: webConfig.appId } : {}),
          ...(webConfig.storageBucket ? { storageBucket: webConfig.storageBucket } : {}),
          ...(webConfig.messagingSenderId
            ? { messagingSenderId: webConfig.messagingSenderId }
            : {}),
        },
      },
    },
  );

  // Switch to the Deploy tab.
  await deployTab.click();

  // Confirm the deploy button is enabled — proves the seed landed and
  // canDeploy resolved true (signed-in via token hatch, target ready,
  // appSource non-empty).
  const deployBtn = page.locator('[data-deploy-track="all"]');
  await expect(deployBtn).toBeEnabled({ timeout: 10_000 });

  await deployBtn.click();

  // Each StepRow renders as: "<symbol> <Label> <summary>". The label
  // span has `uppercase` CSS but the underlying textContent is the
  // original case ("Preflight", "Rules", …) — what `:text-is` matches
  // against.
  await expectStep(page, 'Preflight', '✓');
  await expectStep(page, 'Rules', '✓');
  await expectStep(page, 'Hosting', '✓');
  await expectStep(page, 'Indexes', '✓');

  // Hosting row summary: "<n>/<n> files · https://..."
  const hostingRow = stepRow(page, 'Hosting');
  const hostingText = await hostingRow.textContent();
  const hostingUrlMatch = hostingText?.match(/https:\/\/\S+/);
  expect(hostingUrlMatch, `Hosting URL not found in row: ${hostingText}`).not.toBeNull();
  const hostingUrl = hostingUrlMatch![0];

  // Indexes build-progress section appears only when at least one
  // LRO was started. On a re-deploy with no schema changes, every
  // index 409s as already-exists, no LROs are started, and the
  // section never renders — that's a valid "everything was already
  // ready" outcome. Branch:
  //   - section visible → wait for "All N indexes ready"
  //   - section absent  → skip the wait
  const progressHeading = page.getByRole('heading', { name: /Indexes — build progress/i });
  if ((await progressHeading.count()) > 0) {
    await expect(page.getByText(/All \d+ indexes ready/)).toBeVisible({
      timeout: 5 * 60_000,
    });
  }

  // Seed one document the live app will render. SA bypasses rules.
  await seedProofDoc(PROOF_PROJECT_ID, saToken);

  // Live URL renders. New context so cookies/storage from the
  // playground don't bleed in.
  const liveContext = await browser.newContext();
  const livePage = await liveContext.newPage();
  await livePage.goto(hostingUrl);
  await expect(livePage.getByTestId('proof-rows')).toHaveText(/1 proof row/, {
    timeout: 60_000,
  });
  await liveContext.close();

  // Surface any console errors that fired during the playground run.
  // PyricLeakError surfaces as a console error from the deploy hooks.
  const pyricLeaks = consoleErrors.filter((e) => e.includes('PyricLeakError'));
  expect(pyricLeaks, 'metafile gate fired').toEqual([]);

  // Other console errors — log but don't fail; the deploy steps already
  // assert success. Useful artifact for debugging.
  if (consoleErrors.length > 0) {
    console.log(`[deploy-proof] ${consoleErrors.length} non-leak console errors:`);
    for (const e of consoleErrors) console.log(`  · ${e}`);
  }

  await context.close();
});

/** Locate a StepRow by its uppercase label. */
function stepRow(page: Page, label: string) {
  // The label span has classes `w-16 uppercase tracking-wider text-[10px]`
  // and exact text. Match against the row's parent for the full text.
  return page.locator(`div:has(> span.w-16:text-is("${label}"))`).first();
}

async function expectStep(page: Page, label: string, symbol: string) {
  // Wait up to 4min per step. Hosting can take a minute or two for
  // large bundles + per-file uploads; rules is fast; preflight is
  // <1s; indexes create is a few seconds per index.
  await expect(stepRow(page, label)).toContainText(symbol, { timeout: 4 * 60_000 });
}
