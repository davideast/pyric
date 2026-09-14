import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, get, set, query, orderByChild } from 'pyric/database';
import { createDatabaseRulesDeployment } from '../../src/serve/entries/database-rules.js';

test('serves current rules to existing and later database URLs while keeping their data isolated', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  const first = getDatabase(sandbox, 'https://first.firebaseio.com');
  const second = getDatabase(sandbox, 'https://second.firebaseio.com');
  deployment.register('https://first.firebaseio.com');
  deployment.deploy({ rules: { '.read': true, '.write': true } });
  deployment.register('https://second.firebaseio.com');
  await set(ref(first, 'projects/a'), { score: 1, rank: 2 });
  expect((await get(ref(second, 'projects'))).exists()).toBe(false);
  await expect(get(query(ref(first, 'projects'), orderByChild('score')))).rejects.toThrow('Index not defined');
  for (const index of ['score', 'rank']) {
    deployment.deploy({ rules: { '.read': true, '.write': true, projects: { '.indexOn': index } } });
    expect((await get(query(ref(first, 'projects'), orderByChild(index)))).exists()).toBe(true);
    expect((await get(query(ref(second, 'projects'), orderByChild(index)))).exists()).toBe(false);
  }
  deployment.deploy(null);
  await expect(get(ref(first))).rejects.toThrow('PERMISSION_DENIED');
  await expect(get(ref(second))).rejects.toThrow('PERMISSION_DENIED');
});
