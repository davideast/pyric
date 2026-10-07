import { describe, expect, test } from 'bun:test';
import { rtdbRules } from '../../../src/rules/api/rtdb.js';
import { rtdbRulesSourceRejection } from '../../../src/rules/rtdb/source-rejection.js';

type Rules = { rules: Record<string, unknown> };

describe('rtdbRulesSourceRejection', () => {
  test('a ruleset that is not a rules document is a parse rejection', () => {
    for (const bad of [null, 5, [], {}, { rules: 'x' }, { rules: [] }]) {
      expect(rtdbRulesSourceRejection(bad)?.kind).toBe('parse');
    }
  });

  test('an expression that does not compile is a compile rejection naming its rule', () => {
    const rejection = rtdbRulesSourceRejection({ rules: { '.write': "auth.uid = 'x'" } });
    expect(rejection?.kind).toBe('compile');
    expect(rejection?.message).toContain('/.write:');
    expect(rejection?.findings[0]?.code).toBe('PARSE_ERROR');
  });

  test('a rejection names the nested rule path', () => {
    const rejection = rtdbRulesSourceRejection({
      rules: { rooms: { $roomId: { '.write': 'foo == 1' } } },
    });
    expect(rejection?.message).toContain('/rooms/$roomId/.write:');
  });

  test('a valid ruleset returns null', () => {
    expect(
      rtdbRulesSourceRejection({
        rules: { rooms: { $roomId: { '.read': 'auth != null', '.write': 'newData.exists()', '.indexOn': ['a'] } } },
      }),
    ).toBeNull();
  });
});

describe('tree-structure checks carry production deploy texts', () => {
  const KEY = `String can't contain ".", "#", "$", "/", "[", or "]"`;
  const RULE = "Invalid rule expression.  Expected 'true', 'false', or an expression string.";
  const INDEX = 'Invalid indexOn expression. Must be either a string or an array of strings';
  const OBJECT = "Expected '{'.";
  const MULTIPLE = "Cannot have multiple default rules ('$x' and '$y').";

  // Captured: a production deploy refused the form. Inferred: the form shares
  // the text of a captured refusal and reports as a warning until captured.
  const captured: Array<[string, Rules, string, string]> = [
    ['two wildcard siblings', { rules: { a: { $x: {}, $y: {} } } }, 'MULTIPLE_WILDCARDS', MULTIPLE],
    ['a numeric rule value', { rules: { '.read': 1 } }, 'RULE_NOT_EXPRESSION', RULE],
    ['an object rule value', { rules: { '.validate': { a: 1 } } }, 'RULE_NOT_EXPRESSION', RULE],
    ['a numeric .indexOn', { rules: { '.indexOn': 5 } }, 'INDEX_ON_SHAPE', INDEX],
    ['a key with a hash', { rules: { 'a#b': {} } }, 'INVALID_KEY', KEY],
    ['an unknown dotted key holding an object', { rules: { '.valdiate': {} } }, 'INVALID_KEY', KEY],
    ['an unknown dotted key holding a string', { rules: { '.valdiate': 'true' } }, 'EXPECTED_OBJECT', OBJECT],
    ['a non-rule child holding a string', { rules: { b: 'true' } }, 'EXPECTED_OBJECT', OBJECT],
  ];
  const inferred: Array<[string, Rules, string, string]> = [
    ['a .indexOn array with a non-string member', { rules: { '.indexOn': [1] } }, 'INDEX_ON_SHAPE', INDEX],
    ['a key with a dot', { rules: { 'a.b': {} } }, 'INVALID_KEY', KEY],
    ['a key with a slash', { rules: { 'a/b': {} } }, 'INVALID_KEY', KEY],
    ['a key with brackets', { rules: { 'a[0]': {} } }, 'INVALID_KEY', KEY],
    ['a key with a dollar past the first character', { rules: { a$b: {} } }, 'INVALID_KEY', KEY],
    ['a wildcard key with a dot', { rules: { '$a.b': {} } }, 'INVALID_KEY', KEY],
  ];

  for (const [name, rules, code, message] of captured) {
    test(`${name} is refused`, () => {
      const rejection = rtdbRulesSourceRejection(rules);
      expect(rejection?.kind).toBe('compile');
      expect(rejection?.findings.find((f) => f.code === code)?.message).toBe(message);
      const issues = rtdbRules(rules).lint();
      expect(issues.some((i) => i.code === code && i.severity === 'error')).toBe(true);
    });
  }

  for (const [name, rules, code, message] of inferred) {
    test(`${name} loads with a warning`, () => {
      expect(rtdbRulesSourceRejection(rules)).toBeNull();
      const issue = rtdbRules(rules).lint().find((i) => i.code === code);
      expect(issue?.severity).toBe('warning');
      expect(issue?.message).toBe(message);
    });
  }

  test('a null rule value is refused by the validator as a rule that is not boolean', () => {
    const rejection = rtdbRulesSourceRejection({ rules: { '.write': null } });
    expect(rejection?.findings.map((f) => f.code)).toEqual(['NOT_BOOLEAN']);
  });

  test('a leading wildcard, a boolean rule, a string .indexOn and a nested wildcard are accepted', () => {
    expect(
      rtdbRulesSourceRejection({
        rules: { '.read': true, '.indexOn': 'score', a: { $x: { '.write': false, b: {} } } },
      }),
    ).toBeNull();
  });

  test('an unknown dotted key holding an object is not read as a child location', () => {
    const results = rtdbRules({ rules: { '.valdiate': { '.read': 'true' } } }).simulate([
      { expectation: 'DENY', operation: 'read', path: '/.valdiate', auth: null },
    ]);
    expect(results.passed).toBe(1);
  });
});
