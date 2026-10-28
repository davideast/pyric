/**
 * ─── r29-deploy-rejections ────────────────────────────────────────────────
 * Which rulesets production's rules endpoint refuses, and the error text it
 * returns. Each case is one subtree sent as a dry run, the validation request
 * `firebase deploy` sends before it deploys, so production validates the
 * ruleset and deploys nothing. `firebase deploy` prints the same text after
 * "Syntax error in database rules:".
 *
 *   - Tree structure: two `$` children of one node, a key that starts with `.`
 *     and is not a rule, a rule whose value is not a string or boolean, an
 *     `.indexOn` that is not a string, and a child key with a character a
 *     database key cannot hold, and a child whose value is not an object.
 *   - Expressions: an unknown variable, an undeclared `$` variable, `newData`
 *     in a `.read`, an unknown method, `length` called as a method, a property
 *     read on a snapshot, a snapshot used as an operand, an arithmetic type
 *     error, a rule whose result is not a boolean, a method called with the
 *     wrong argument count, argument type or receiver, an unknown `query`
 *     field, and an assignment.
 *   - A ruleset of about 300 KB, over the documented 256 KB size limit. The
 *     dry run accepts it: its validation does not apply that limit. A deploy
 *     without the dry-run flag was not probed.
 *
 * One accepted control case shows the dry run accepts a valid ruleset, and
 * two accepted cases mark where production stops checking: an operand whose
 * type is only known at evaluation (`auth.uid + 1`), and an unknown property
 * of `auth`.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

/** About 300 KB of rules: 400 nodes, each keyed by a 750-character name with a
 *  `.read` of `true`. The bytes sit in keys rather than expressions, so Pyric's
 *  own load-time check, which parses every expression, stays fast. */
function oversizedSubtree(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < 400; index++) {
    out[`${String(index).padStart(3, '0')}${'k'.repeat(747)}`] = { '.read': 'true' };
  }
  return out;
}

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a ruleset production refuses to deploy must be refused when Pyric loads it, so each refusal and its text is the evidence that turns a local check from a warning into an error.',
  provenance:
    'Authored to record which rulesets the Realtime Database rules endpoint rejects. Expectations are the verdicts and error texts recorded by the dry-run capture in observations/rtdb-rules/rules-rtdb-r29-deploy-rejections.json.',
  deployCases: [
    {
      description: 'a valid ruleset is accepted',
      construct: 'rtdb.rule-kind.read',
      rules: subtree({ a: { '.read': 'auth != null', '.write': false } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'two $ children of one node',
      construct: 'rtdb.rule-kind.sibling-wildcards',
      rules: subtree({ a: { $x: { '.read': 'true' }, $y: { '.read': 'true' } } }),
      expectation: { verdict: 'REJECTED', error: "Cannot have multiple default rules ('$x' and '$y')." },
    },
    {
      description: 'a key starting with . that is not a rule',
      construct: 'rtdb.rule-kind.unknown-key',
      rules: subtree({ a: { '.valdiate': 'true' } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'a number as a rule value',
      construct: 'rtdb.rule-kind.non-expression-value',
      rules: subtree({ a: { '.read': 1 } }),
      expectation: { verdict: 'REJECTED', error: "Invalid rule expression.  Expected 'true', 'false', or an expression string." },
    },
    {
      description: 'an object as a rule value',
      construct: 'rtdb.rule-kind.non-expression-value',
      rules: subtree({ a: { '.write': { x: 1 } } }),
      expectation: { verdict: 'REJECTED', error: "Invalid rule expression.  Expected 'true', 'false', or an expression string." },
    },
    {
      description: 'a number as the .indexOn value',
      construct: 'rtdb.rule-kind.indexOn-non-string',
      rules: subtree({ a: { '.indexOn': 5 } }),
      expectation: { verdict: 'REJECTED', error: "Invalid indexOn expression. Must be either a string or an array of strings" },
    },
    {
      description: 'a child key containing #',
      construct: 'rtdb.rule-kind.invalid-key',
      rules: subtree({ 'a#b': { '.read': 'true' } }),
      expectation: { verdict: 'REJECTED', error: 'String can\'t contain ".", "#", "$", "/", "[", or "]"' },
    },
    {
      description: 'an unknown variable',
      construct: 'rtdb.binding.unknown-variable',
      rules: subtree({ a: { '.read': 'foo == 1' } }),
      expectation: { verdict: 'REJECTED', error: "Unknown variable 'foo'." },
    },
    {
      description: 'a $ variable no ancestor declares',
      construct: 'rtdb.binding.unbound-path-variable',
      rules: subtree({ a: { '.read': "$nope == 'x'" } }),
      expectation: { verdict: 'REJECTED', error: "Unknown variable '$nope'." },
    },
    {
      description: 'newData in a .read rule',
      construct: 'rtdb.binding.newData-in-read',
      rules: subtree({ a: { '.read': 'newData.exists()' } }),
      expectation: { verdict: 'REJECTED', error: "newData is invalid in .read expressions." },
    },
    {
      description: 'an unknown snapshot method',
      construct: 'rtdb.method.snapshot.unknown',
      rules: subtree({ a: { '.read': 'data.foo()' } }),
      expectation: { verdict: 'REJECTED', error: "No such method/property 'foo'." },
    },
    {
      description: 'an unknown method on a value',
      construct: 'rtdb.method.string.unknown',
      rules: subtree({ a: { '.write': 'newData.val().bar()' } }),
      expectation: { verdict: 'REJECTED', error: "No such method/property 'bar'." },
    },
    {
      description: 'length called as a method',
      construct: 'rtdb.method.string.length-call',
      rules: subtree({ a: { '.write': 'newData.val().length() > 0' } }),
      expectation: { verdict: 'REJECTED', error: "Type error: Function call on target that is not a function." },
    },
    {
      description: 'a property read on a snapshot',
      construct: 'rtdb.operator.member.snapshot-property',
      rules: subtree({ a: { '.read': 'data.foo == 1' } }),
      expectation: { verdict: 'REJECTED', error: "No such method/property 'foo'." },
    },
    {
      description: 'a snapshot compared with a number',
      construct: 'rtdb.operator.snapshot-operand',
      rules: subtree({ a: { '.read': 'data > 1' } }),
      expectation: { verdict: 'REJECTED', error: "Invalid > expression: left operand must be a number or string." },
    },
    {
      description: 'a string plus a number compared with a string',
      construct: 'rtdb.operator.dynamic-operand',
      rules: subtree({ a: { '.read': "auth.uid + 1 > 'x'" } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'a rule whose result is a string',
      construct: 'rtdb.rule-kind.non-boolean-result',
      rules: subtree({ a: { '.read': 'auth.uid' } }),
      expectation: { verdict: 'REJECTED', error: "Expression must evaluate to a boolean." },
    },
    {
      description: 'a rule whose result is a number',
      construct: 'rtdb.rule-kind.non-boolean-result',
      rules: subtree({ a: { '.read': '1' } }),
      expectation: { verdict: 'REJECTED', error: "Expression must evaluate to a boolean." },
    },
    {
      description: 'child() with no argument',
      construct: 'rtdb.method.snapshot.arity',
      rules: subtree({ a: { '.read': 'data.child().exists()' } }),
      expectation: { verdict: 'REJECTED', error: "child() expects 1 argument." },
    },
    {
      description: 'a snapshot method on auth',
      construct: 'rtdb.semantic.method-wrong-receiver',
      rules: subtree({ a: { '.read': 'auth.exists()' } }),
      expectation: { verdict: 'REJECTED', error: "Type error: Function call on target that is not a function." },
    },
    {
      description: 'a string method on a snapshot',
      construct: 'rtdb.semantic.method-wrong-receiver',
      rules: subtree({ a: { '.read': "data.contains('a')" } }),
      expectation: { verdict: 'REJECTED', error: "No such method/property 'contains'." },
    },
    {
      description: 'an assignment instead of a comparison',
      construct: 'rtdb.semantic.parse-error',
      rules: subtree({ a: { '.read': "auth.uid = 'x'" } }),
      expectation: { verdict: 'REJECTED', error: "Rule expressions may not contain assignments." },
    },
    {
      description: 'rules over 256 KB',
      construct: 'rtdb.semantic.rules-size-limit',
      rules: subtree({ a: oversizedSubtree() }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'a key starting with . whose value is an object',
      construct: 'rtdb.rule-kind.unknown-key',
      rules: subtree({ a: { '.valdiate': {} } }),
      expectation: { verdict: 'REJECTED', error: 'String can\'t contain ".", "#", "$", "/", "[", or "]"' },
    },
    {
      description: 'a child key whose value is a string',
      construct: 'rtdb.rule-kind.non-object-child',
      rules: subtree({ a: { b: 'true' } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'a string minus a number',
      construct: 'rtdb.operator.type-mismatch',
      rules: subtree({ a: { '.read': "'a' - 1 > 0" } }),
      expectation: { verdict: 'REJECTED', error: "Invalid - expression: left operand is not a number." },
    },
    {
      description: 'a boolean compared with a number',
      construct: 'rtdb.operator.type-mismatch',
      rules: subtree({ a: { '.read': 'true > 1' } }),
      expectation: { verdict: 'REJECTED', error: "Invalid > expression: left operand must be a number or string." },
    },
    {
      description: 'not applied to a string',
      construct: 'rtdb.operator.type-mismatch',
      rules: subtree({ a: { '.read': "!'a'" } }),
      expectation: { verdict: 'REJECTED', error: "! only operates on booleans." },
    },
    {
      description: 'an unknown property on auth',
      construct: 'rtdb.operator.member.auth-unknown-property',
      rules: subtree({ a: { '.read': 'auth.foo == 1' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'an unknown property on query',
      construct: 'rtdb.binding.query.unknown-field',
      rules: subtree({ a: { '.read': 'query.foo == 1' } }),
      expectation: { verdict: 'REJECTED', error: "No such method/property 'foo'." },
    },
    {
      description: 'child() with two arguments',
      construct: 'rtdb.method.snapshot.arity',
      rules: subtree({ a: { '.read': "data.child('a', 'b').exists()" } }),
      expectation: { verdict: 'REJECTED', error: "child() expects 1 argument." },
    },
    {
      description: 'matches() with a string argument',
      construct: 'rtdb.semantic.method-argument-type',
      rules: subtree({ a: { '.write': "newData.val().matches('a')" } }),
      expectation: { verdict: 'REJECTED', error: "matches() expects a regular expression literal argument." },
    },
    {
      description: 'hasChild() with a number argument',
      construct: 'rtdb.semantic.method-argument-type',
      rules: subtree({ a: { '.read': 'data.hasChild(1)' } }),
      expectation: { verdict: 'REJECTED', error: "hasChild() expects a string argument." },
    },
  ],
};
