import { describe, expect, test } from 'bun:test';
import { rtdbRules } from '../../src/index.js';

const PRIORITY_AND_COUNTER_RULES = {
  rules: {
    orgs: {
      $orgId: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        '.validate': 'newData.getPriority() === null || (newData.isNumber() === false && newData.getPriority() >= 0)',
        count: {
          '.validate': 'newData.isNumber() && newData.val() === data.val() + 1',
        },
        title: {
          '.validate': 'newData.isString()',
        },
      },
    },
  },
};

describe('RTDB .priority simulation scope', () => {
  test('rtdbRules().simulate() evaluates write and validate cases at /.priority paths while keeping invalid paths unsupported', () => {
    const ruleset = rtdbRules(PRIORITY_AND_COUNTER_RULES);
    const summary = ruleset.simulate([
      {
        description: 'priority-only write on existing node with untouched monotonic child',
        operation: 'write',
        path: '/orgs/o1/.priority',
        auth: { uid: 'u1' },
        data: { orgs: { o1: { title: 'alpha', count: 5 } } },
        newData: 10,
        expectation: 'ALLOW',
      },
      {
        description: 'priority-only write violating owner .validate',
        operation: 'write',
        path: '/orgs/o1/.priority',
        auth: { uid: 'u1' },
        data: { orgs: { o1: { title: 'alpha', count: 5 } } },
        newData: -10,
        expectation: 'DENY',
      },
      {
        description: 'priority-only validate operation at /.priority',
        operation: 'validate',
        path: '/orgs/o1/.priority',
        auth: { uid: 'u1' },
        data: { orgs: { o1: { title: 'alpha', count: 5 } } },
        newData: 15,
        expectation: 'ALLOW',
      },
      {
        description: 'update case with sibling and .priority',
        operation: 'update',
        path: '/orgs/o1',
        auth: { uid: 'u1' },
        data: { orgs: { o1: { title: 'alpha', count: 5 } } },
        newData: { title: 'beta', '.priority': 20 },
        expectation: 'ALLOW',
      },
    ]);

    expect(summary.unsupported).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(4);

    // Invalid key segment before /.priority, /.info/.priority, and read on /.priority remain UNSUPPORTED:
    const refused = ruleset.simulate([
      {
        operation: 'write',
        path: '/orgs/bad.key/.priority',
        auth: { uid: 'u1' },
        newData: 10,
        expectation: 'ALLOW',
      },
      {
        operation: 'write',
        path: '/.info/.priority',
        auth: { uid: 'u1' },
        newData: 10,
        expectation: 'ALLOW',
      },
      {
        operation: 'read',
        path: '/orgs/o1/.priority',
        auth: { uid: 'u1' },
        expectation: 'ALLOW',
      },
    ]);
    expect(refused.unsupported).toBe(3);
    expect(refused.cases[0]!.reason).toContain('invalid path = "/orgs/bad.key/.priority"');
    expect(refused.cases[1]!.reason).toBe("set failed = Can't modify data under /.info/");
    expect(refused.cases[2]!.reason).toContain('invalid path = "/orgs/o1/.priority"');
  });
});
