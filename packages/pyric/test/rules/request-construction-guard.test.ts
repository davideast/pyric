import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// Every place that writes a rules `request` by hand is a place that can
// build it differently from production and from the other planes (#1884 was
// one). #1521 replaces them with one operation form per service, `check()`
// in @pyric/rules (plan D3 Firestore, D6 Storage, D9 RTDB), which builds
// `request` and `resource` and returns what it built. Until each caller
// moves, the sites that exist are listed below, one entry per site, by file.
// The list only shrinks: a new site fails this test, and so does an entry
// whose site is gone. Adding an entry is a change for review, not a fix.
//
// The detection rule, applied to the TypeScript syntax tree of every `.ts`
// file under packages/pyric/src and packages/cli/src:
//
//   A site is an object literal with an `auth` property and a verb property
//   (`method` or `operation`) that either
//     (a) is given the name `request`: the value of a `request:` property or
//         the initializer of a `request` variable. This is the `request` a
//         Firestore or Storage evaluation reads, the rules-language binding,
//         and the request a denial reports back; or
//     (b) has a key only a rules evaluation input carries: `expectation`
//         (a Firestore or RTDB case) or `mockData`, `newData` or `now` (an
//         RTDB simulation input).
//
// A literal with a `result` key records a verdict, so it is an event, not a
// request, even when it is named `request` (Firestore's request events are).
// Parentheses, `as`, `satisfies`, `!` and both branches of a conditional are
// looked through, so a cast or a ternary is still a site. The `resource`
// built beside a request belongs to that request's site. A literal that only
// names an operation (`{ method, path, auth }` passed to a builder such as
// `buildRulesTestCase`) is not a site.
const ALLOWED_SITES: readonly string[] = [
  // Firestore: denials that report the request, the sandbox's case builder (D4) and the assurance pass's case.
  'packages/pyric/src/firestore/sandbox/atomic-write-pipeline.ts',
  'packages/pyric/src/firestore/sandbox/rules-list-authorizer.ts',
  'packages/pyric/src/firestore/sandbox/rules-list-authorizer.ts',
  'packages/pyric/src/firestore/sandbox/rules-list-authorizer.ts',
  'packages/pyric/src/firestore/sandbox/rules-read-engine.ts',
  'packages/pyric/src/firestore/sandbox/rules-read-engine.ts',
  'packages/pyric/src/firestore/sandbox/rules-test-case.ts',
  'packages/pyric/src/firestore/sandbox/transaction-write-executor.ts',
  'packages/pyric/src/firestore/sandbox/write-engine.ts',
  'packages/pyric/src/assurance-surface/passes/static-query-proof-eval.ts',
  // Firestore: CLI simulate, verify and the worker's observation (D5).
  'packages/cli/src/bridge/surface/rules-simulation.ts',
  'packages/cli/src/serve/worker/host/observe-local-firestore.ts',
  'packages/cli/src/verify/cases.ts',
  // Storage: in-page operations and the evaluator's binding (D6, D7).
  'packages/pyric/src/storage/download.ts',
  'packages/pyric/src/storage/download.ts',
  'packages/pyric/src/storage/list.ts',
  'packages/pyric/src/storage/metadata.ts',
  'packages/pyric/src/storage/metadata.ts',
  'packages/pyric/src/storage/sandbox/rules-bindings.ts',
  'packages/pyric/src/storage/upload.ts',
  // Storage: the worker, the CLI engine and verify (D8).
  'packages/cli/src/bridge/surface/rules-engines/storage.ts',
  'packages/cli/src/serve/worker/host/observe-local-storage.ts',
  'packages/cli/src/serve/worker/host/storage.ts',
  'packages/cli/src/verify/index.ts',
  // RTDB: the sandbox evaluator, the CLI engine and inspection, the worker's observation (D9).
  'packages/pyric/src/database/sandbox/rules-eval.ts',
  'packages/cli/src/bridge/surface/rules-engines/database.ts',
  'packages/cli/src/bridge/surface/rules-engines/database.ts',
  'packages/cli/src/rtdb/inspection.ts',
  'packages/cli/src/rtdb/inspection.ts',
  'packages/cli/src/serve/worker/host/observe-local-rtdb.ts',
];

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SCANNED_ROOTS = ['packages/pyric/src', 'packages/cli/src'];

const VERB_KEYS = ['method', 'operation'];
const EVALUATION_INPUT_KEYS = ['expectation', 'mockData', 'newData', 'now'];
const EVENT_KEY = 'result';

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function hasRequestShape(literal: ts.ObjectLiteralExpression): boolean {
  const keys = literal.properties.map(propertyName);
  const hasVerb = VERB_KEYS.some((key) => keys.includes(key));
  const isEvent = keys.includes(EVENT_KEY);
  return keys.includes('auth') && hasVerb && !isEvent;
}

function hasEvaluationInputKey(literal: ts.ObjectLiteralExpression): boolean {
  const keys = literal.properties.map(propertyName);
  return EVALUATION_INPUT_KEYS.some((key) => keys.includes(key));
}

/** The object literals an expression evaluates to, through casts, parentheses and conditionals. */
function literalsOf(expression: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isObjectLiteralExpression(expression)) return [expression];
  const isWrapper =
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression);
  if (isWrapper) return literalsOf(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...literalsOf(expression.whenTrue), ...literalsOf(expression.whenFalse)];
  return [];
}

/** The literals given the name `request`, by property or by variable. */
function namedRequestLiterals(node: ts.Node): ts.ObjectLiteralExpression[] {
  const isRequestProperty = ts.isPropertyAssignment(node) && propertyName(node) === 'request';
  if (isRequestProperty) return literalsOf(node.initializer);
  const isRequestVariable =
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'request' && node.initializer !== undefined;
  if (isRequestVariable) return literalsOf(node.initializer!);
  return [];
}

/** One `<path>` per site in a file, where `<path>` is relative to `base`. */
function sitesInFile(base: string, file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = new Set<ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    for (const literal of namedRequestLiterals(node)) {
      if (hasRequestShape(literal)) sites.add(literal);
    }
    const isEvaluationInput = ts.isObjectLiteralExpression(node) && hasRequestShape(node) && hasEvaluationInputKey(node);
    if (isEvaluationInput) sites.add(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const path = relative(base, file).split(sep).join('/');
  return [...sites].map(() => path);
}

function typeScriptFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => join(root, file));
}

/** One entry per site under each root, as a path relative to `base`, sorted. */
function constructionSites(base: string, roots: readonly string[]): string[] {
  return roots
    .flatMap((root) => typeScriptFiles(join(base, root)))
    .flatMap((file) => sitesInFile(base, file))
    .sort();
}

/** The entries of `from` left after removing one occurrence per entry of `remove`. */
function withoutEach(from: readonly string[], remove: readonly string[]): string[] {
  const left = [...from];
  for (const entry of remove) {
    const index = left.indexOf(entry);
    if (index !== -1) left.splice(index, 1);
  }
  return left;
}

function compareToAllowlist(sites: readonly string[], allowed: readonly string[]): { added: string[]; stale: string[] } {
  return { added: withoutEach(sites, allowed), stale: withoutEach(allowed, sites) };
}

const NEW_SITE_MESSAGE =
  'new hand-built rules requests. Build request and resource with the service\'s check() from @pyric/rules ' +
  '(#1521: D3 Firestore, D6 Storage, D9 RTDB) or an existing builder, instead of writing the literal';

describe('hand-built rules requests (#1521 D0)', () => {
  test('no site outside the shrink-only list', () => {
    const { added } = compareToAllowlist(constructionSites(REPO_ROOT, SCANNED_ROOTS), ALLOWED_SITES);
    expect(added, NEW_SITE_MESSAGE).toEqual([]);
  });

  test('the list names only sites that still exist, so it can only shrink', () => {
    const { stale } = compareToAllowlist(constructionSites(REPO_ROOT, SCANNED_ROOTS), ALLOWED_SITES);
    expect(stale, 'remove these entries from ALLOWED_SITES').toEqual([]);
  });
});

describe('the request construction guard on a fixture tree', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'request-construction-'));
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  function write(path: string, lines: readonly string[]): void {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), lines.join('\n'));
  }

  write('src/not-sites.ts', [
    "emit({ at: 1, method: 'get', path, auth, result: 'allow' });",
    "const request: EmitRequestInput = { at, evalMs, method: 'get', path, auth, result: 'deny' };",
    "env.execute({ method: 'update', path, auth, data });",
    "const testCase = buildRulesTestCase(state, { method: 'get', path, auth }, time);",
    "error({ request: requestFromCheck, resource });",
    "send({ request: params.request, model });",
    "const request = { method: 'POST', url, headers };",
    "const shape = `{ request: { method: 'get', path, auth } }`;",
  ]);
  write('src/listed.ts', [
    "enforce({ request: { auth, method: 'read', path }, resource: resourceFromStored(existing) });",
  ]);

  test('reads operations, events, forwarded requests and strings as no sites', () => {
    expect(constructionSites(fixture, ['src']).filter((site) => site.endsWith('not-sites.ts'))).toEqual([]);
  });

  test('finds each form of the rule, one entry per site', () => {
    write('src/forms.ts', [
      "makeError('permission-denied', 'denied', { request: { method: 'get', path, auth } });",
      "const request: StorageRequest = { auth, method: 'write', path, resource: incoming };",
      "evaluate({ request: (isList ? { method: 'list', path, auth } : { method: 'get', path, auth }) as EvalRequest });",
      "const testCase = { description: 'x', expectation: 'ALLOW', method: 'get', path, auth, requestTime };",
      "simulateRtdbRules(compiled, { operation: 'read', path, auth, mockData, now: 0 });",
      "const rtdbCase = { expectation: 'DENY', operation: 'write', path, auth, newData: 1 } satisfies RtdbCase;",
    ]);
    expect(constructionSites(fixture, ['src']).filter((site) => site.endsWith('forms.ts'))).toEqual(
      Array(7).fill('src/forms.ts'),
    );
  });

  test('fails on a new site that is not in the list', () => {
    write('src/new-site.ts', [
      "export function readRule(path: string, auth: unknown) {",
      "  return enforce({ request: { auth, method: 'get', path }, resource: null });",
      "}",
    ]);
    const sites = constructionSites(fixture, ['src']).filter((site) => !site.endsWith('forms.ts'));
    expect(compareToAllowlist(sites, ['src/listed.ts'])).toEqual({ added: ['src/new-site.ts'], stale: [] });
  });

  test('fails on a list entry whose site is gone', () => {
    const allowed = ['src/listed.ts', 'src/removed.ts'];
    const sites = constructionSites(fixture, ['src']).filter((site) => site.endsWith('listed.ts'));
    expect(compareToAllowlist(sites, allowed)).toEqual({ added: [], stale: ['src/removed.ts'] });
  });

  test('counts each site, so a second site in a listed file is a new site', () => {
    write('src/twice.ts', [
      "enforce({ request: { auth, method: 'get', path }, resource });",
      "enforce({ request: { auth, method: 'list', path }, resource: null });",
    ]);
    const sites = constructionSites(fixture, ['src']).filter((site) => site.endsWith('twice.ts'));
    expect(compareToAllowlist(sites, ['src/twice.ts']).added).toEqual(['src/twice.ts']);
  });
});
