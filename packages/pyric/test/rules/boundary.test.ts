import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// The rules engine becomes @pyric/rules, the lowest layer, so nothing in
// src/rules may import the rest of pyric (#1521). Each edge that does today is
// listed below as `<file under src/rules> -> <specifier>`, one entry per import
// statement. The list only shrinks: a new edge fails this test, and so does an
// entry whose import is gone, so a PR that removes an edge removes its entry.
// Adding an entry is a boundary change for review in #1521, not a fix.
const ALLOWED_EDGES: readonly string[] = [
  // One-line shims left at the old paths after the production Rules API
  // handlers moved to src/rules-production.
  'inspect/handler.ts -> ../../rules-production/inspect/handler.js',
  'test/handler.ts -> ../../rules-production/test/handler.js',
  'write/handler.ts -> ../../rules-production/write/handler.js',
  // One-line shims left at the old paths after the agent tools moved to
  // src/rules-tools.
  'inspect/tools.ts -> ../../rules-tools/inspect/tools.js',
  'stdlib-tools.ts -> ../rules-tools/stdlib-tools.js',
  'tools.ts -> ../rules-tools/tools.js',
  // One-line shims left at the old paths after the simulator tools moved to
  // src/rules-tools.
  'simulator-tools-impl.ts -> ../rules-tools/simulator-tools-impl.js',
  'simulator.ts -> ../rules-tools/simulator.js',
  // One-line shims left at the old paths after index extraction moved to
  // src/indexes.
  'indexes/extract/composite.ts -> ../../../indexes/extract/composite.js',
  'indexes/extract/extractor.ts -> ../../../indexes/extract/extractor.js',
  'indexes/extract/types.ts -> ../../../indexes/extract/types.js',
  'indexes/extractHandler.ts -> ../../indexes/extractHandler.js',
  'indexes/extractTool.ts -> ../../indexes/extractTool.js',
  'indexes/types.ts -> ../../indexes/types.js',
  // Shared groundwork, which moves down into the engine.
  'api/rtdb-case-validation.ts -> ../../database/writable-path.js',
  'api/rtdb-case-validation.ts -> ../../sandbox/branches/state-diff.js',
  'api/rtdb-firebase-json.ts -> ../../sandbox/internal/database-rules-config.js',
  'api/rtdb-instance-case.ts -> ../../sandbox/internal/instances.js',
  'rtdb/simulation/handler.ts -> ../../../sandbox/internal/auth-token-claims.js',
  'rtdb/simulation/handler.ts -> ../../../sandbox/sandbox-context.js',
  'rtdb/simulation/post-write-tree.ts -> ../../../database/sandbox/normalize.js',
  'rtdb/simulation/post-write-tree.ts -> ../../../database/sandbox/sentinels.js',
  'rtdb/simulation/spec.ts -> ../../../database/internal/query-projection.js',
  'rtdb/simulation/spec.ts -> ../../../database/query-validation.js',
];

const RULES_ROOT = resolve(import.meta.dir, '../../src/rules');

/**
 * Marks a statement the guard cannot place, so it fails closed: an `import()`
 * or `require` whose argument is not a literal string, or a `declare module`
 * for a relative path, which augments a module elsewhere in the tree.
 */
const UNPLACEABLE = '<unplaceable>';

/**
 * Every module specifier a file names: imports, re-exports, `import()`, import
 * types, `require`, `import x = require()` and `declare module`. A statement
 * the guard cannot place is returned as `<unplaceable> <what it is>`.
 */
function moduleSpecifiers(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const addString = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const isRelative = node.name.text.startsWith('.');
      specifiers.push(isRelative ? `${UNPLACEABLE} declare module '${node.name.text}'` : node.name.text);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addString(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addString(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addString(node.argument.literal);
    } else if (ts.isCallExpression(node) && isImportOrRequire(node.expression)) {
      const argument = node.arguments[0];
      const isLiteral = argument !== undefined && ts.isStringLiteralLike(argument);
      if (isLiteral) addString(argument);
      else specifiers.push(`${UNPLACEABLE} ${node.expression.getText(sourceFile)}(${argument?.getText(sourceFile) ?? ''})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isImportOrRequire(callee: ts.Expression): boolean {
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  return isDynamicImport || isRequire;
}

/** The workspace's own packages, which sit above the engine. */
const PYRIC_PACKAGES = ['pyric', 'pyric-admin', 'create-pyric'];

/** Pyric itself under any name: a self-import reaches outside the engine whatever subpath it names. */
function isPyricPackage(specifier: string): boolean {
  const isUnscoped = PYRIC_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
  const isScoped = specifier.startsWith('@pyric/');
  return isUnscoped || isScoped;
}

function leavesRoot(root: string, file: string, specifier: string): boolean {
  if (specifier.startsWith(UNPLACEABLE)) return true;
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!isRelative) return isPyricPackage(specifier);
  const target = relative(root, resolve(dirname(file), specifier));
  return target === '..' || target.startsWith(`..${sep}`);
}

function typeScriptFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(root, file));
}

/** One `<file> -> <specifier>` entry per statement that imports from outside `root`, sorted. */
function boundaryEdges(root: string): string[] {
  return typeScriptFiles(root)
    .flatMap((file) =>
      moduleSpecifiers(file)
        .filter((specifier) => leavesRoot(root, file, specifier))
        .map((specifier) => `${relative(root, file).split(sep).join('/')} -> ${specifier}`),
    )
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

function compareToAllowlist(edges: readonly string[], allowed: readonly string[]): { added: string[]; stale: string[] } {
  return { added: withoutEach(edges, allowed), stale: withoutEach(allowed, edges) };
}

describe('src/rules import boundary (#1521)', () => {
  test('imports nothing from outside src/rules beyond the allowlist', () => {
    const { added } = compareToAllowlist(boundaryEdges(RULES_ROOT), ALLOWED_EDGES);
    expect(added, 'new imports out of src/rules; the engine is the lowest layer').toEqual([]);
  });

  test('the allowlist names only imports that still exist, so it can only shrink', () => {
    const { stale } = compareToAllowlist(boundaryEdges(RULES_ROOT), ALLOWED_EDGES);
    expect(stale, 'remove these entries from ALLOWED_EDGES').toEqual([]);
  });
});

describe('the boundary guard on a fixture tree', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rules-boundary-'));
  const root = join(fixture, 'src/rules');
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  function write(path: string, source: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }

  write('engine.ts', [
    "import { a } from './grammar/a.js';",
    "import ts from 'typescript';",
    "import { readFileSync } from 'node:fs';",
    "export const text = \"import { x } from '../sandbox/x.js'\";",
    "export const code = `export { y } from 'pyric/rules';`;",
  ].join('\n'));
  write('grammar/a.ts', "export { b } from '../engine.js';");
  write('allowed.ts', "import type { ToolHandler } from '../sandbox/internal/tool-handler.js';");

  test('reads a tree with only internal, third-party and builtin imports as having no edges, ignoring strings', () => {
    const clean = mkdtempSync(join(tmpdir(), 'rules-boundary-clean-'));
    try {
      writeFileSync(join(clean, 'engine.ts'), readFileSync(join(root, 'engine.ts'), 'utf8'));
      expect(boundaryEdges(clean)).toEqual([]);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  test('fails on a new edge that is not in the allowlist', () => {
    write('nested/deep/new-edge.ts', [
      "import { normalizeAuthState } from '../../../sandbox/sandbox-context.js';",
      "export type Env = import('pyric/sandbox/internal').LocalEnvironment;",
      "export { replay } from '../../../database/replay.js';",
      "export const later = () => import('@pyric/cli');",
    ].join('\n'));
    const allowed = ['allowed.ts -> ../sandbox/internal/tool-handler.js'];
    const edges = boundaryEdges(root).filter((edge) => edge.startsWith('nested/') || edge.startsWith('allowed.ts'));
    expect(compareToAllowlist(edges, allowed)).toEqual({
      added: [
        'nested/deep/new-edge.ts -> ../../../database/replay.js',
        'nested/deep/new-edge.ts -> ../../../sandbox/sandbox-context.js',
        'nested/deep/new-edge.ts -> @pyric/cli',
        'nested/deep/new-edge.ts -> pyric/sandbox/internal',
      ],
      stale: [],
    });
  });

  test('counts require, import-equals and export-star edges, and fails closed on what it cannot place', () => {
    write('forms/edges.ts', [
      "const sandbox = require('../../sandbox/index.js');",
      "import admin = require('pyric-admin');",
      "export * from '../../database/replay.js';",
      "export * as scaffold from 'create-pyric/templates';",
      "const name = './grammar/a.js';",
      "export const dynamic = () => import(name);",
      "export const built = () => require(`../${name}`);",
      "declare module './grammar/a.js' { interface A { extra: true } }",
      "declare module 'ohm-js' { interface Grammar { extra: true } }",
      "import inside = require('../engine.js');",
    ].join('\n'));
    const edges = boundaryEdges(root).filter((edge) => edge.startsWith('forms/'));
    expect(edges).toEqual([
      'forms/edges.ts -> ../../database/replay.js',
      'forms/edges.ts -> ../../sandbox/index.js',
      "forms/edges.ts -> <unplaceable> declare module './grammar/a.js'",
      'forms/edges.ts -> <unplaceable> import(name)',
      'forms/edges.ts -> <unplaceable> require(`../${name}`)',
      'forms/edges.ts -> create-pyric/templates',
      'forms/edges.ts -> pyric-admin',
    ]);
  });

  test('fails on an allowlist entry whose import is gone', () => {
    const allowed = [
      'allowed.ts -> ../sandbox/internal/tool-handler.js',
      'removed.ts -> ../project-scope.js',
    ];
    expect(compareToAllowlist(boundaryEdges(root), allowed).stale).toEqual(['removed.ts -> ../project-scope.js']);
  });

  test('counts each statement, so a second import of an allowlisted module is a new edge', () => {
    write('twice.ts', [
      "export { replay } from '../database/replay.js';",
      "export type { ReplayStep } from '../database/replay.js';",
    ].join('\n'));
    const edges = boundaryEdges(root).filter((edge) => edge.startsWith('twice.ts'));
    expect(compareToAllowlist(edges, ['twice.ts -> ../database/replay.js']).added).toEqual(['twice.ts -> ../database/replay.js']);
  });
});
