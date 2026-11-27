import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

export default scenario(async (app) => {
  await app.step('each caller can list only items filtered by their own email', async () => {
    const result = await app.command('node', ['owner-query.mjs']);
    assert.equal(result.code, 0, result.output);
  });
});
