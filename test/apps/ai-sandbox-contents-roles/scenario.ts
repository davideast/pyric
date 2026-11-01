// In the default sandbox AI mode, a `contents` turn under role `assistant` is
// accepted, as production accepts it (ai-contents-role-assistant), and a turn
// under role `system` is refused with production's 400 INVALID_ARGUMENT text
// (ai-contents-role-system). The page runs both in Chromium on the SharedWorker
// sandbox and again on the Node host. A `node --import @pyric/cli/register`
// process is not a plane here: firebase/ai refuses to run in a server process.
// The app calls initializeAppCheck before getAI. The scenario records every
// request that leaves for a host other than the dev server and aborts it, so
// nothing reaches Google or Firebase.
import assert from 'node:assert/strict';
import { scenario, type App } from '../driver.ts';

const SYSTEM_REFUSAL = "Role 'system' is not supported. Please use a valid role: MODEL, USER.";

interface Outcome { ok: boolean; text?: string; status?: number | null; error?: string }
interface Roles { assistant: Outcome; system: Outcome }
declare function runRoles(): Promise<Roles>;

function assertRoles(roles: Roles): void {
  assert.equal(roles.assistant.ok, true, `assistant turn: ${JSON.stringify(roles.assistant)}`);
  assert.ok(roles.assistant.text, 'the assistant turn got an empty reply');
  assert.equal(roles.system.ok, false, `system turn: ${JSON.stringify(roles.system)}`);
  assert.ok(roles.system.error?.includes(SYSTEM_REFUSAL), `system turn error: ${roles.system.error}`);
  assert.equal(roles.system.status, 400);
}

async function checkPlane(app: App, name: string, env: Record<string, string>): Promise<void> {
  const host = await app.devServer({ name, env });
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'runRoles' in window);
  assertRoles(await page.evaluate(() => runRoles()));
  // The SDK's error text omits the status name, so read it from the host's log.
  assert.match(host.process.output, new RegExp(`${SYSTEM_REFUSAL}\\s+model: .*\\s+INVALID_ARGUMENT \\(400\\)`));
  assert.doesNotMatch(host.process.output, /Role 'assistant' is not supported/);
  await host.process.stop();
}

export default scenario(async (app) => {
  const external: string[] = [];
  await app.step('record any request that leaves for another host', async () => {
    const context = await app.browser();
    await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => {
      external.push(route.request().url());
      return route.abort();
    });
  });

  await app.step('the SharedWorker sandbox accepts an assistant turn and refuses a system turn', () =>
    checkPlane(app, 'SharedWorker dev server', {}));

  await app.step('the Node host accepts an assistant turn and refuses a system turn', () =>
    checkPlane(app, 'Node host dev server', { SCENARIO_HOSTED: '1' }));

  await app.step('no request left for Google or Firebase', () => {
    assert.deepEqual(external, []);
  });
});
