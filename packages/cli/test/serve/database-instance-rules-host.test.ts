import { describe, expect, test } from 'bun:test';
import {
  connectDatabaseInstanceRules,
  type DatabaseInstanceRulesHost,
} from '../../src/serve/database-instance-rules-host.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';

function fakeHost(refuse: ReadonlySet<string> = new Set()) {
  const calls: Array<['declare', string[]] | ['set', string, RtdbRulesJson | null]> = [];
  const host: DatabaseInstanceRulesHost = {
    declareInstances(names) {
      calls.push(['declare', [...names]]);
    },
    setDatabaseRules(instance, rules) {
      if (refuse.has(instance)) throw new Error(`refused by the host`);
      calls.push(['set', instance, rules]);
    },
  };
  return { host, calls };
}

const A = { rules: { a: { '.read': true } } };
const B = { rules: { b: { '.read': true } } };

describe('connectDatabaseInstanceRules', () => {
  test('declares every instance, then sets each instance its own rules', () => {
    const { host, calls } = fakeHost();
    connectDatabaseInstanceRules(host, { defaultInstance: 'demo-default-rtdb', rules: { a: A, b: B, c: null } });
    expect(calls).toEqual([
      ['declare', ['a', 'b', 'c']],
      ['set', 'a', A],
      ['set', 'b', B],
      ['set', 'c', null],
    ]);
  });

  test('a reload sets only the instance whose rules changed', () => {
    const { host, calls } = fakeHost();
    const reload = connectDatabaseInstanceRules(host, { defaultInstance: 'demo-default-rtdb', rules: { a: A, b: B } });
    calls.length = 0;
    reload('b', A);
    reload('a', null);
    expect(calls).toEqual([['set', 'b', A], ['set', 'a', null]]);
  });

  test('a reload for an instance the config does not declare throws', () => {
    const { host } = fakeHost();
    const reload = connectDatabaseInstanceRules(host, { defaultInstance: 'demo-default-rtdb', rules: { a: A } });
    expect(() => reload('other', A)).toThrow('database instance "other" is not declared in firebase.json');
  });

  test('one instance the host refuses does not keep the others from loading, and the error names it', () => {
    const { host, calls } = fakeHost(new Set(['a']));
    expect(() => connectDatabaseInstanceRules(host, { defaultInstance: 'demo-default-rtdb', rules: { a: A, b: B } }))
      .toThrow('database instance "a": refused by the host');
    expect(calls).toEqual([['declare', ['a', 'b']], ['set', 'b', B]]);
  });
});
