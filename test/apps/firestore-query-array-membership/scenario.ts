import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

export default scenario(async (app) => {
  await app.step('list by membership before and after changing an item’s members', async () => {
    const result = await app.command('node', ['membership.mjs']);
    assert.equal(result.code, 0, result.output);
  });
});
