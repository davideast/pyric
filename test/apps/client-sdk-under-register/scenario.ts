// A server process started with `node --import @pyric/cli/register` and
// PYRIC_SANDBOX=remote:<Node host url> uses the client Firebase SDKs, as a
// script or a server-rendered route does. They have no path to the host yet,
// so each one refuses with failed-precondition and says to use
// firebase-admin, instead of running against a private in-process sandbox
// whose writes the host never sees (#1082).
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

type Outcome = { ok: true; value: unknown } | { ok: false; code: string | null; message: string };

function outcome(output: string, name: string): Outcome {
  const match = output.match(new RegExp(`^${name.replace('.', '\\.')} (.*)$`, 'm'));
  assert.ok(match, `no ${name} line in:\n${output}`);
  return JSON.parse(match[1]) as Outcome;
}

const REFUSAL = /^pyric: client Firebase SDKs .* do not reach the sandbox host from a server process yet \(PYRIC_SANDBOX=remote:http:\/\/127\.0\.0\.1:\d+\)\. Use firebase-admin in server code\. See https:\/\/github\.com\/davideast\/pyric\/issues\/1082\.$/;

export default scenario(async (app) => {
  const host = await app.step('start the Node host', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  const client = await app.step('the client SDKs run in a registered server process', async () => {
    const { output } = await app.serverScript('client.mjs', [], { env });
    return output;
  });

  for (const service of ['database', 'firestore', 'auth', 'storage']) {
    await app.step(`client ${service} refuses with failed-precondition and names firebase-admin`, () => {
      const result = outcome(client, service);
      assert.equal(result.ok, false, `${service} must not succeed against a private sandbox: ${JSON.stringify(result)}`);
      assert.equal(result.ok === false && result.code, 'failed-precondition', JSON.stringify(result));
      assert.match(result.ok === false ? result.message : '', REFUSAL);
    });
  }

  await app.step('client functions keeps its deferred-mirror error', () => {
    const result = outcome(client, 'functions');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.ok === false ? result.message : '', /'firebase\/functions' is not yet mirrored/);
  });

  await app.step('nothing the client SDKs tried to write is on the host', async () => {
    const { output } = await app.serverScript('admin.mjs', [], { env });
    assert.deepEqual(outcome(output, 'admin.database'), { ok: true, value: null }, output);
    assert.deepEqual(outcome(output, 'admin.firestore'), { ok: true, value: null }, output);
    assert.deepEqual(outcome(output, 'admin.auth'), { ok: true, value: [] }, output);
    assert.deepEqual(outcome(output, 'admin.storage'), { ok: true, value: false }, output);
  });
});
