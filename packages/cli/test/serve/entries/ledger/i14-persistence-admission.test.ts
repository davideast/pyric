import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { requiresHealthyPersistence } from '../../../../src/serve/hosted/persistence-admission.js';

const workerDirectory = fileURLToPath(new URL('../../../../src/serve/worker/', import.meta.url));
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const protocol = parse(`${workerDirectory}/protocol.ts`);
const declaration = protocol.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'OpMessage');
if (!declaration) throw new Error('Missing OpMessage declaration');

const methods = new Set<string>();
function collectMethods(node: ts.Node): void {
  const isMethod = ts.isPropertySignature(node) && node.name.getText(protocol) === 'method';
  if (isMethod && node.type && ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) {
    methods.add(node.type.literal.text);
  }
  ts.forEachChild(node, collectMethods);
}
collectMethods(declaration);

// Follow the actual persistence calls, including checkpoints and queued disconnect writes.
const persistenceCalls = new Set(['bestEffortFlush', 'saveCheckpoint', 'removeCheckpoint', 'drainPortRtdbDisconnects', 'setAuthProviderConfig']);
function reachesPersistence(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
    const isPersistenceCall = ts.isIdentifier(name) && persistenceCalls.has(name.text);
    if (isPersistenceCall) return true;
  }
  return ts.forEachChild(node, reachesPersistence) === true;
}
const mutations = new Set<string>();
function collectMutations(node: ts.Node): void {
  if (ts.isSwitchStatement(node)) {
    const pendingCases: string[] = [];
    for (const clause of node.caseBlock.clauses) {
      const isMethodCase = ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression);
      if (isMethodCase) pendingCases.push(clause.expression.text);
      if (reachesPersistence(clause)) {
        for (const method of pendingCases) mutations.add(method);
      }
      if (clause.statements.length > 0) pendingCases.length = 0;
    }
  }
  ts.forEachChild(node, collectMutations);
}
for (const directory of [workerDirectory, `${workerDirectory}/host`]) {
  for (const name of readdirSync(directory)) {
    const isHostSource = name.endsWith('.ts');
    if (isHostSource) collectMutations(parse(`${directory}/${name}`));
  }
}

test('the protocol walk includes every service and the persistence paths are nonempty', () => {
  expect(methods.size).toBeGreaterThan(90);
  expect(mutations.has('auth.setProviderConfig')).toBe(true);
  expect(mutations.has('rtdb.goOffline')).toBe(true);
  expect(mutations.has('checkpoint')).toBe(true);
  expect(mutations.has('deleteCheckpoint')).toBe(true);
});

for (const method of methods) {
  const persistsState = mutations.has(method);
  if (!persistsState) continue;
  test(`${method} requires healthy persistence before entering its mutation handler`, () => {
    const message = JSON.parse(JSON.stringify({ t: 'op', id: 'admission', method }));
    expect(requiresHealthyPersistence(message)).toBe(true);
  });
}
