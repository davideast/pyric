// A Firestore rules file with two `service cloud.firestore` blocks (#1900).
// Production refuses it with "Duplicate service name declaration." (capture
// c5b-two-firestore-services, the file this project's `firestore.rules`
// holds). `pyric sandbox` refuses it at load too, and its terminal output
// gives production's reason, not a bare parse position.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

const REASON = 'firestore.rules: Firestore rules did not compile: Duplicate service name declaration. Fix the rules before serving.';

export default scenario(async (app) => {
  await app.step("pyric sandbox refuses the rules file with production's reason", async () => {
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], {
      timeoutMs: 90_000,
    });
    assert.notEqual(result.code, 0, result.output);
    assert.ok(result.output.includes(REASON), result.output);
  });
});
