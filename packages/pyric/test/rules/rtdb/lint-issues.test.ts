import { describe, test, expect } from 'bun:test';
import { rtdbRules, allow, deny, expr } from 'pyric/rules';

const summarize = (issues: ReturnType<ReturnType<typeof rtdbRules>['lint']>) =>
  issues.map(({ code, origin, path, rule }) => ({ code, origin, path, rule }));

describe('rtdbRules().lint() names the stage and the rule each issue came from', () => {
  test('a .read and .write that are false outright are two lint issues, one per rule', () => {
    const issues = rtdbRules({ paths: { '/rooms/$id': { read: 'false', write: 'false' } } }).lint();
    expect(summarize(issues)).toEqual([
      { code: 'HARDCODED_FALSE', origin: 'lint', path: '/rooms/$id', rule: '.read' },
      { code: 'HARDCODED_FALSE', origin: 'lint', path: '/rooms/$id', rule: '.write' },
    ]);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  test('a write rule that compares a value to false has no issues', () => {
    const issues = rtdbRules({
      paths: { '/rooms/$id': { write: "auth != null && data.child('open').val() == false" } },
    }).lint();
    expect(issues).toEqual([]);
  });

  test('a rule that does not parse is a parse issue', () => {
    const issues = rtdbRules({ paths: { '/rooms/$id': { write: 'auth != null && (' } } }).lint();
    expect(summarize(issues)).toEqual([
      { code: 'PARSE_ERROR', origin: 'parse', path: '/rooms/$id', rule: '.write' },
    ]);
    expect(issues[0]!.severity).toBe('error');
  });

  test('a rule that parses but fails validation is a validate issue', () => {
    const issues = rtdbRules({ paths: { '/rooms/$id': { read: 'room != null' } } }).lint();
    expect(summarize(issues)).toEqual([
      { code: 'UNKNOWN_IDENTIFIER', origin: 'validate', path: '/rooms/$id', rule: '.read' },
    ]);
  });

  test('a ruleset that does not compile is a parse issue with no rule', () => {
    const issues = rtdbRules({
      paths: () => {
        throw new Error('definition failed');
      },
    }).lint();
    expect(summarize(issues)).toEqual([
      { code: 'COMPILE_ERROR', origin: 'parse', path: '/', rule: undefined },
    ]);
  });

  test('compose helpers that produce literals lint like the literal on .read and .write, and not on .validate', () => {
    const issues = rtdbRules({
      paths: {
        '/open': { read: allow(), write: deny() },
        '/items/$id/$other': { validate: deny() },
        '/items/$id/title': { validate: expr('true') },
      },
    }).lint();
    expect(summarize(issues)).toEqual([
      { code: 'HARDCODED_TRUE', origin: 'lint', path: '/open', rule: '.read' },
      { code: 'HARDCODED_FALSE', origin: 'lint', path: '/open', rule: '.write' },
    ]);
  });
});
