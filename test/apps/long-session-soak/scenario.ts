// A long session on a real app, to find the crashes and bugs that only show up
// over time. The scenario scaffolds the create-pyric web template, turns on
// the Node host (`pyric({ hosted: true })`, so state lasts through reloads,
// tabs, and restarts, and the dev server holds the sandbox whose memory is
// measured), and adds email accounts, fielded posts, and listeners next to
// the template's own Google sign-in and post form (soak-page.ts).
//
// A seeded script then uses the app for SOAK_MINUTES (default 60): sign-ups,
// sign-ins and sign-outs, Firestore writes, reads, queries and denied writes,
// listeners added and removed, reloads, a second tab, and now and then a dev
// server restart. Every few minutes it compares what the app reads back, its
// own list, and each listener with a model of what the script wrote.
//
// It fails on any crash in the page or the dev server, an error page, a
// state check that does not match, an action that does not settle, steady
// memory growth in a page load or a dev server process, or a long dev server
// process whose memory does not level off (memory.ts). A failure
// names the seed, the action index, and the last 20 actions; the whole action
// log and every memory sample are saved under test-results/apps/long-session-soak/.
//
//   SOAK_SEED=<n or word> SOAK_MINUTES=<n> bun test/apps/run.ts long-session-soak

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { scenario, type App, type DevServer } from '../driver.ts';
import { DEFAULT_MINUTES, soakSettings } from '../soak.ts';
import { inspectedEnv } from './inspector.ts';
import { within } from './model.ts';
import { ACTION_LIMIT_MS, PROJECT, type SoakPage } from './page-api.ts';
import { Soak } from './soak-run.ts';

declare const soak: SoakPage;

export const slow = true;

/** The runner's limit for this app: the soak's own length, plus room to install, start, and judge it. */
export const timeoutMs = (soakMinutesForTimeout() + 10) * 60_000;

function soakMinutesForTimeout(): number {
  try {
    return soakSettings(process.env).minutes;
  } catch {
    // The scenario reports a bad SOAK_MINUTES when it runs; the runner reads this while loading every app.
    return DEFAULT_MINUTES;
  }
}

const RESULTS = join(import.meta.dir, '../../../test-results/apps/long-session-soak');

/** Scaffolds the web template, turns on the Node host, and wires in soak-page.ts. */
async function scaffold(app: App): Promise<void> {
  await app.step('create-pyric scaffolds the web template', async () => {
    const result = await app.command('node', ['node_modules/create-pyric/dist/bin.js', PROJECT, '--template', 'web']);
    assert.equal(result.code, 0, result.output);
  });
  // PROJECT, spelled out: dependency-store.test.ts reads the nested projects from the scenario's own text.
  await app.step('install the scaffolded project', () => app.installProject('my-web'));
  await app.step('run it on the Node host and add the soak helpers to the template', () => {
    const config = app.readFile(`${PROJECT}/vite.config.ts`);
    const hosted = config.replace('pyric({', 'pyric({\n      hosted: true,');
    assert.notEqual(hosted, config, 'vite.config.ts has no pyric({ to edit');
    app.writeFile(`${PROJECT}/vite.config.ts`, hosted);
    app.writeFile(`${PROJECT}/src/soak-page.ts`, app.readFile('soak-page.ts'));
    const main = app.readFile(`${PROJECT}/src/main.ts`);
    assert.match(main, /^const auth = getAuth\(app\);$/m);
    assert.match(main, /^const db = getFirestore\(app\);$/m);
    app.writeFile(`${PROJECT}/src/main.ts`, `${main}\nimport { installSoak } from './soak-page';\ninstallSoak(auth, db);\n`);
  });
}

async function openApp(app: App, host: DevServer): Promise<Page> {
  const context = await app.browser();
  const banner = new Promise<string>((resolve) => {
    context.on('console', (message) => { if (message.text().startsWith('[pyric sandbox] firebase/*')) resolve(message.text()); });
  });
  const page = await app.page(host.url);
  const text = await within('the sandbox banner', ACTION_LIMIT_MS, banner);
  assert.match(text, /on the dev server/, text);
  await page.waitForFunction(() => 'soak' in globalThis, undefined, { timeout: ACTION_LIMIT_MS });
  assert.equal(await page.evaluate(() => soak.authSettled()), null);
  return page;
}

export default scenario(async (app) => {
  const settings = await app.step('read SOAK_SEED and SOAK_MINUTES', () => soakSettings(process.env));
  console.log(`  long-session-soak: SOAK_SEED=${settings.seed} SOAK_MINUTES=${settings.minutes}, first restart at action ${settings.firstRestartAction}`);
  // A restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  // The allowance lasts the whole run, since restarts come at any point after the first.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/, { mayNotHappen: 'a race decides whether the post lands before the new routes mount (#2098)' });
  await scaffold(app);
  const inspectorPort = await app.freePort();
  const host = await app.step('start the scaffolded project on the Node host, with an inspector', () =>
    app.devServer({ cwd: PROJECT, env: inspectedEnv(inspectorPort) }));
  const page = await app.step('open the app; it runs on the dev server, signed out', () => openApp(app, host));
  const run = new Soak(app, await app.browser(), host, page, settings, inspectorPort, process.env.SOAK_HEAP_SNAPSHOTS === '1', RESULTS);
  await app.step(`use the app for ${settings.minutes} minutes (SOAK_SEED=${settings.seed})`, async () => {
    try {
      await run.run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await run.captureFailure();
      // The memory verdict so far, since a run that stops early never reaches the step that judges it.
      const memory = run.memory.verdict();
      const report = `${run.session.log.describeFailure(settings.seed, run.session.current, reason)}\nmemory so far${memory.growing ? ', growing' : ''}:\n${memory.report}`;
      throw new Error(report, { cause: error });
    } finally {
      run.save();
      run.memory.closeInspector();
    }
    console.log(`  long-session-soak: ${run.session.log.entries.length} actions, saved to ${RESULTS}`);
    console.log(run.latency().join('\n').replace(/^/gm, '  '));
  });
  await app.step("neither the page's heap nor the dev server's memory grew steadily or failed to level off", () => {
    const { growing, report } = run.memory.verdict();
    writeFileSync(join(RESULTS, 'soak-memory-verdict.txt'), `${report}\n`);
    console.log(report.replace(/^/gm, '  '));
    assert.ok(!growing, `memory grew (SOAK_SEED=${settings.seed}):\n${report}`);
  });
});
