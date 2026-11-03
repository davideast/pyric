// An app's server reads the ID token from `Authorization: Bearer <token>`,
// splits the header on the space, and verifies the token with firebase-admin
// (#1836). Production's ID token is a JWT, three base64url segments with no
// whitespace whatever the claims hold. Pyric's used to carry the claims as
// JSON, so a display name with a space, such as `Builder One`, cut the token
// at the space and verifyIdToken failed to parse it, and a name outside
// Latin-1, such as `李`, made the browser refuse the header before the request
// left the page.
//
// The token's `iss` and `aud` name the app's project, as production's do
// (#1503): `https://securetoken.google.com/<projectId>` and the project id.
//
// The page runs on the hosted dev server. The API is a
// `node --import @pyric/cli/register` process, which also signs in through
// firebase/auth itself and sends its own token.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Answer { status?: number; body?: Record<string, unknown>; threw?: string }
declare function runBearer(apiUrl: string, displayName: string, email: string): Promise<{ uid: string; answer: Answer }>;

const PROJECT = 'demo-bearer';

function verified(uid: string, name: string): Answer {
  return { status: 200, body: { uid, name, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}` } };
}

const USERS = [
  { displayName: 'Builder One', email: 'builder@example.com' },
  { displayName: '李', email: 'li@example.com' },
];

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const apiUrl = await app.step('start the API under register', async () => {
    const port = await app.freePort();
    const server = app.serverProcess('api-server.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}`, API_PORT: String(port) } });
    await server.waitForLog(/api-server listening/);
    return `http://127.0.0.1:${port}`;
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runBearer' in window);
    return page;
  });

  for (const { displayName, email } of USERS) {
    await app.step(`the API verifies the Bearer token of a user named ${displayName}`, async () => {
      const { uid, answer } = await page.evaluate(
        ([url, name, address]) => runBearer(url, name, address),
        [apiUrl, displayName, email] as const,
      );
      assert.deepEqual(answer, verified(uid, displayName), JSON.stringify(answer));
    });
  }

  await app.step('the API verifies the Bearer token its own process signs in for', async () => {
    const response = await fetch(`${apiUrl}/self`);
    const result = await response.json() as { uid?: string; answer?: Answer; threw?: string };
    assert.equal(result.threw, undefined, JSON.stringify(result));
    assert.deepEqual(result.answer, verified(result.uid ?? '', 'Builder One'), JSON.stringify(result));
  });
});
