import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, get, set, query, orderByChild } from 'pyric/database';
import { createDatabaseRulesDeployment } from '../../src/serve/entries/database-rules.js';

const OPEN = { rules: { '.read': true, '.write': true } };

test('serves current rules to existing and later database URLs while keeping their data isolated', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  const first = getDatabase(sandbox, 'https://first.firebaseio.com');
  const second = getDatabase(sandbox, 'https://second.firebaseio.com');
  deployment.register('https://first.firebaseio.com');
  deployment.deploy({ defaultInstance: 'demo-default-rtdb', rules: { first: OPEN, second: OPEN } });
  deployment.register('https://second.firebaseio.com');
  await set(ref(first, 'projects/a'), { score: 1, rank: 2 });
  expect((await get(ref(second, 'projects'))).exists()).toBe(false);
  await expect(get(query(ref(first, 'projects'), orderByChild('score')))).rejects.toThrow('Index not defined');
  for (const index of ['score', 'rank']) {
    const indexed = { rules: { '.read': true, '.write': true, projects: { '.indexOn': index } } };
    deployment.deployInstance('first', indexed);
    deployment.deployInstance('second', indexed);
    expect((await get(query(ref(first, 'projects'), orderByChild(index)))).exists()).toBe(true);
    expect((await get(query(ref(second, 'projects'), orderByChild(index)))).exists()).toBe(false);
  }
  deployment.deploy(null);
  await expect(get(ref(first))).rejects.toThrow('PERMISSION_DENIED');
  await expect(get(ref(second))).rejects.toThrow('PERMISSION_DENIED');
});

// Production deploys each firebase.json entry's rules to its own instance.
test('applies each instance its own ruleset', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  deployment.register('https://first.firebaseio.com');
  deployment.deploy({
    defaultInstance: 'demo-default-rtdb',
    rules: {
      first: { rules: { first: { '.read': true } } },
      second: { rules: { second: { '.read': true } } },
    },
  });
  deployment.register('https://second.firebaseio.com');
  const first = getDatabase(sandbox, 'https://first.firebaseio.com');
  const second = getDatabase(sandbox, 'https://second.firebaseio.com');
  expect((await get(ref(first, 'first'))).exists()).toBe(false);
  await expect(get(ref(first, 'second'))).rejects.toThrow('PERMISSION_DENIED');
  expect((await get(ref(second, 'second'))).exists()).toBe(false);
  await expect(get(ref(second, 'first'))).rejects.toThrow('PERMISSION_DENIED');

  // Replacing one instance's rules leaves the other's in force.
  deployment.deployInstance('second', { rules: { first: { '.read': true } } });
  expect((await get(ref(second, 'first'))).exists()).toBe(false);
  await expect(get(ref(first, 'second'))).rejects.toThrow('PERMISSION_DENIED');
  expect((await get(ref(first, 'first'))).exists()).toBe(false);
});

test('serves the default instance rules to a database opened without a URL', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  deployment.deploy({
    defaultInstance: 'demo-default-rtdb',
    rules: { 'demo-default-rtdb': OPEN, other: { rules: { '.read': false } } },
  });
  await set(ref(getDatabase(sandbox), 'a'), 1);
  expect((await get(ref(getDatabase(sandbox), 'a'))).val()).toBe(1);
});

test('an instance without rules follows the default policy', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  deployment.register('https://undeclared.firebaseio.com');
  deployment.deploy({ defaultInstance: 'demo-default-rtdb', rules: { declared: OPEN } }, 'deny');
  await expect(get(ref(getDatabase(sandbox, 'https://undeclared.firebaseio.com')))).rejects.toThrow('PERMISSION_DENIED');
  deployment.deploy({ defaultInstance: 'demo-default-rtdb', rules: { declared: OPEN } }, 'allow');
  expect((await get(ref(getDatabase(sandbox, 'https://undeclared.firebaseio.com'), 'x'))).exists()).toBe(false);
});

test('a refused ruleset names its instance, and the other instances still get theirs', async () => {
  const sandbox = initializeSandbox();
  const deployment = createDatabaseRulesDeployment(sandbox);
  deployment.register('https://good.firebaseio.com');
  deployment.register('https://refused.firebaseio.com');
  expect(() => deployment.deploy({
    defaultInstance: 'demo-default-rtdb',
    rules: { good: OPEN, refused: { rules: { '.read': 'newData.exists()' } } },
  })).toThrow('database instance "refused"');
  expect((await get(ref(getDatabase(sandbox, 'https://good.firebaseio.com'), 'x'))).exists()).toBe(false);
  await expect(get(ref(getDatabase(sandbox, 'https://refused.firebaseio.com')))).rejects.toThrow('PERMISSION_DENIED');

  // A refused reload leaves that instance's rules in force.
  expect(() => deployment.deployInstance('good', { rules: { '.read': 'newData.exists()' } })).toThrow('database instance "good"');
  expect((await get(ref(getDatabase(sandbox, 'https://good.firebaseio.com'), 'x'))).exists()).toBe(false);
});
