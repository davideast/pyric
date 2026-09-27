import { describe, test, expect } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { assembleExpression, assembleRules } from '../../../src/rules/grammar/FirestoreAssembler.js';
import type { Expression, FirestoreRules } from '../../../src/rules/grammar/FirestoreAST.js';
import { resolveModulesWithFiles } from '../../../src/rules/modules/resolver-browser.js';

// The printed form of a string or bytes literal must parse back to the same
// value under the grammar's escape set.

function rulesWith(literal: string, version = '2'): string {
  return `rules_version = '${version}';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if resource.data.s == ${literal}; }
  }
}`;
}

function conditionLiteral(ast: FirestoreRules): Expression {
  const condition = ast.service.match.children[0]!.allows[0]!.condition;
  if (condition.type !== 'binaryOp') throw new Error('expected a comparison');
  return condition.right;
}

function literalValue(source: string): unknown {
  const ast = parseToAST(rulesWith(source));
  if (ast === null) throw new Error(`literal does not parse: ${source}`);
  const expr = conditionLiteral(ast);
  if (expr.type !== 'literal') throw new Error('expected a literal');
  return expr.value;
}

function roundTrip(source: string): { printed: string; before: unknown; after: unknown } {
  const ast = parseToAST(rulesWith(source));
  if (ast === null) throw new Error(`literal does not parse: ${source}`);
  const printed = assembleExpression(conditionLiteral(ast));
  return { printed, before: literalValue(source), after: literalValue(printed) };
}

const STRING_BODIES: ReadonlyArray<[string, string]> = [
  ['apostrophe', "it's"],
  ['escaped apostrophe', "it\\'s"],
  ['double quote', 'say \\"hi\\"'],
  ['backslash', 'a\\\\b'],
  ['newline escape', 'a\\nb'],
  ['tab escape', 'a\\tb'],
  ['hex escape', '\\x41'],
  ['unicode escape', '\\u00e9'],
  ['literal non-ASCII', 'é'],
  ['octal escape', '\\101'],
];

describe('assembler string literal round-trip', () => {
  for (const [name, body] of STRING_BODIES) {
    for (const quote of ['"', "'"]) {
      // A bare quote character cannot appear inside a literal delimited by
      // the same character.
      if (quote === "'" && body === "it's") continue;
      if (quote === '"' && body.includes('"') && !body.includes('\\"')) continue;
      const source = `${quote}${body}${quote}`;
      test(`${name} in ${quote === '"' ? 'double' : 'single'} quotes: ${source}`, () => {
        const { printed, before, after } = roundTrip(source);
        expect(typeof before).toBe('string');
        expect(after).toBe(before as string);
        expect(printed.length).toBeGreaterThan(0);
      });
    }
  }
});

describe('assembler bytes literal round-trip', () => {
  for (const source of ["b'\\x41it\\'s\\101'", 'b"\\x41it\'s\\"\\101"', "B'abc'", 'B"abc"']) {
    test(source, () => {
      const { before, after } = roundTrip(source);
      expect(before).toBeInstanceOf(Uint8Array);
      expect(after).toEqual(before);
    });
  }
});

describe('assembled rules with an apostrophe in a double-quoted string', () => {
  test('assembleRules output parses to the same value', () => {
    const ast = parseToAST(rulesWith('"it\'s"'));
    expect(ast).not.toBeNull();
    const reparsed = parseToAST(assembleRules(ast!));
    expect(reparsed).not.toBeNull();
    const expr = conditionLiteral(reparsed!);
    expect(expr.type === 'literal' ? expr.value : undefined).toBe("it's");
  });

  test('resolveModulesWithFiles output on a 2+modules ruleset parses to the same value', () => {
    const result = resolveModulesWithFiles(rulesWith('"it\'s"', '2+modules'), () => null, { basePath: '/rules' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const reparsed = parseToAST(result.data.resolved);
    expect(reparsed).not.toBeNull();
    const expr = conditionLiteral(reparsed!);
    expect(expr.type === 'literal' ? expr.value : undefined).toBe("it's");
  });
});
