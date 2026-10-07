/**
 * The RTDB validator type-checks a rule expression as production's rules
 * compiler does when `firebase deploy` validates database rules.
 *
 * `fixtures/type-check/captures.json` holds production's verdict for each
 * probe, captured with `PUT /.settings/rules.json?dryRun=true` by
 * `packages/conformance/src/capture-rtdb-rules-type-check.ts`. Each probe places
 * one expression at `/p/$id`. The replay asserts that the local compile rejects
 * exactly the probes production rejects, and that the first validation error
 * carries production's message.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RULES_RTDB_SCENARIOS } from '../../../../../conformance/rules-corpus/rtdb/index.ts';
import { rtdbRules } from 'pyric/rules';
import { buildRuleExpression, compileRtdbRules } from '../../../../src/rules/rtdb/compiled-rules.js';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';
import type { RtdbNode } from '../../../../src/rules/rtdb/types.js';

interface Capture {
  name: string;
  kind: 'read' | 'write' | 'validate';
  expression: string;
  accepted: boolean;
  message?: string;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'type-check', 'captures.json'), 'utf8'),
) as { probes: Capture[] };

/**
 * Probes production accepts that the expression grammar does not parse: the
 * grammar reads a call only as `receiver.name(...)`, so a call on an index
 * expression is a parse error locally.
 */
const GRAMMAR_GAPS = new Set(['snapshot-index-method-name']);

/** Probes production rejects that the grammar already refuses to parse, so no validation message applies. */
function isParseError(errors: { code: string }[]): boolean {
  return errors.length > 0 && errors.every((e) => e.code === 'PARSE_ERROR');
}

describe('RTDB validator matches production deploy validation', () => {
  test('the capture covers every operand position for every static type', () => {
    expect(fixture.probes.length).toBeGreaterThan(900);
  });

  for (const capture of fixture.probes) {
    if (GRAMMAR_GAPS.has(capture.name)) continue;
    test(`${capture.name}: ${capture.expression}`, () => {
      const { errors } = buildRuleExpression(capture.expression, capture.kind, ['$id']).parsed;
      if (capture.accepted) {
        expect(errors).toEqual([]);
        return;
      }
      expect(errors.length).toBeGreaterThan(0);
      if (isParseError(errors)) return;
      expect(errors[0]!.message).toBe(capture.message!);
    });
  }

  test('each grammar gap is still a production acceptance the grammar refuses', () => {
    for (const name of GRAMMAR_GAPS) {
      const capture = fixture.probes.find((p) => p.name === name)!;
      expect(capture.accepted).toBe(true);
      const { errors } = buildRuleExpression(capture.expression, capture.kind, ['$id']).parsed;
      expect(isParseError(errors)).toBe(true);
    }
  });
});

describe('validation error codes', () => {
  const codes = (raw: string, context: 'read' | 'write' | 'validate' = 'read', vars: string[] = ['$id']) =>
    validateExpression(raw, context, vars).map((e) => e.code);

  test.each([
    ['$other == auth.uid', 'UNKNOWN_IDENTIFIER'],
    ["auth.uid.length() > 0", 'NOT_A_FUNCTION'],
    ['data.foo == 1', 'NO_SUCH_MEMBER'],
    ["data.contains('a')", 'NO_SUCH_MEMBER'],
    ["'s'.val() == 's'", 'NO_SUCH_MEMBER'],
    ['auth.exists()', 'NOT_A_FUNCTION'],
    ['now.foo == 1', 'NOT_AN_OBJECT'],
    ["'abc'[0] == 'a'", 'INVALID_PROPERTY_ACCESS'],
    ['data > 1', 'INVALID_OPERAND'],
    ["data != 'locked'", 'INVALID_OPERAND'],
    ['!auth.uid', 'INVALID_OPERAND'],
    ['auth.uid', 'NOT_BOOLEAN'],
    ['data.val()', 'NOT_BOOLEAN'],
    ['data.child().exists()', 'INVALID_ARGUMENT'],
    ['data.hasChild()', 'INVALID_ARGUMENT'],
    ['data.child(1).exists()', 'INVALID_ARGUMENT'],
    ["auth.uid.matches('a')", 'INVALID_ARGUMENT'],
    ["data.hasChildren('a')", 'INVALID_ARGUMENT'],
    ["['a'] == ['a']", 'UNEXPECTED_ARRAY'],
  ])('%s reports %s', (raw, code) => {
    expect(codes(raw)[0]).toBe(code);
  });

  test('an assignment is a parse error with production text, from the r28 deploy-rejection capture', () => {
    for (const raw of ["auth.uid = 'x'", "(auth.uid = 'x') && true"]) {
      expect(buildRuleExpression(raw, 'read', ['$id']).parsed.errors).toEqual([
        { code: 'PARSE_ERROR', message: 'Rule expressions may not contain assignments.' },
      ]);
    }
    expect(buildRuleExpression("auth.uid == '=' && auth.uid != 'a=b'", 'read').parsed.errors).toEqual([]);
  });

  test('a rule production refuses draws its refusal and no security finding: it never runs', () => {
    const issues = rtdbRules({ rules: { probe: { '.write': "data == 'locked'" } } }).lint()
      .filter((issue) => issue.severity === 'error');
    expect(issues.map((issue) => issue.message)).toEqual([
      'Invalid == expression: left operand is not a number, boolean, string, null.',
    ]);
  });

  test('newData in a .read rule reports NEWDATA_IN_READ', () => {
    expect(codes('newData.exists()')).toEqual(['NEWDATA_IN_READ']);
  });

  test('snapshot operands in write arithmetic report INVALID_OPERAND', () => {
    expect(codes('newData + 1 > 0', 'write')[0]).toBe('INVALID_OPERAND');
  });

  test('query is readable in every rule kind', () => {
    for (const kind of ['read', 'write', 'validate'] as const) {
      expect(codes('query.limitToFirst <= 50', kind)).toEqual([]);
    }
  });

  test('one error per failing operand: an error does not cascade to its parents', () => {
    expect(codes('data.foo > 1 && data.bar == 2')).toEqual(['NO_SUCH_MEMBER', 'NO_SUCH_MEMBER']);
  });
});

describe('accepted idioms stay clean', () => {
  test.each([
    ["newData.child('x').val() >= 0", 'write'],
    ["root.child('a/' + $id).exists()", 'read'],
    ['auth.token.admin == true', 'read'],
    ['query.limitToFirst <= 50', 'read'],
    ["newData.hasChildren(['host', 'guest'])", 'write'],
    ["newData.child('puck/vx').val() * newData.child('puck/vx').val() + newData.child('puck/vy').val() * newData.child('puck/vy').val() <= 400", 'write'],
    ["newData.child('host').val() == data.child('host').val() + 1", 'write'],
    ['$id == "host"', 'write'],
    ['!data.exists() || newData.child(\'t\').val() > data.child(\'t\').val()', 'write'],
    ['newData.val() === now', 'validate'],
    ["auth.token.firebase.sign_in_provider == 'password'", 'read'],
    ['newData.isString() && newData.val().length <= 100 && newData.val().matches(/^[a-z]+$/i)', 'validate'],
  ] as const)('%s', (raw, context) => {
    expect(validateExpression(raw, context, ['$id'])).toEqual([]);
  });
});

function ruleErrors(node: RtdbNode): string[] {
  const own = [node.read, node.write, node.validate]
    .flatMap((rule) => (rule ? rule.parsed.errors.map((e) => `${node.path} ${rule.raw}: ${e.message}`) : []));
  return [...own, ...node.children.flatMap(ruleErrors)];
}

describe('every ruleset production deployed in the RTDB corpus compiles without errors', () => {
  for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
    test(scenario.id, () => {
      const compiled = compileRtdbRules({ rules: { [scenario.id]: JSON.parse(scenario.rules) } });
      expect(ruleErrors(compiled)).toEqual([]);
    });
  }
});
