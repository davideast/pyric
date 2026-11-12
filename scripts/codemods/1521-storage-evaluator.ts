#!/usr/bin/env bun
/**
 * Moves the Storage rules evaluator out of `packages/pyric` into
 * `packages/rules/src/storage` (`@pyric/rules/internal/storage`, #1521 PR 13)
 * and rewrites every reference to the moved files. Checked in so a branch that
 * still edits the old paths can merge main and run it again: every step skips
 * what is already done.
 *
 * Run from the repository root:
 *
 *   bun scripts/codemods/1521-storage-evaluator.ts           # move and rewrite
 *   bun scripts/codemods/1521-storage-evaluator.ts --dry-run # print the plan only
 *
 * What it does, in order:
 *
 * 1. Picks the source files that move: each `storage/sandbox/rules*.ts` and
 *    `storage/rules-resolution.ts` whose imports are only the engine, each
 *    other, or a pyric module that re-exports engine names. A file that
 *    imports any other pyric module stays, and so does every file that
 *    imports one that stays.
 * 2. Picks the tests that move, by the rule of the package move (#2594): a
 *    test under `packages/pyric/test/storage` or `packages/pyric/test/rules`
 *    that imports a moved file moves unless it imports pyric outside the
 *    engine, a package the engine does not depend on, or a test helper that
 *    stays. A Storage test keeps its path under `packages/rules/test`
 *    (`storage/...`); a rules test goes where the package move put the rest
 *    of `test/rules`.
 * 3. Moves them (git mv) and writes `packages/rules/src/internal/storage.ts`,
 *    the barrel that re-exports every moved module.
 * 4. Rewrites imports. A moved file imports the engine by relative path, one
 *    statement per defining module, since nothing in the package may import
 *    `@pyric/rules` by name. Pyric's own modules and tests import the moved
 *    files from `@pyric/rules/internal/storage`. Anything else (conformance,
 *    scripts) keeps a relative path to the new location.
 * 5. Rewrites path strings that name a moved file (registry rows, corpus,
 *    scripts, docs).
 *
 * It prints what it could not place, for a hand edit.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '../..');
const DRY_RUN = process.argv.includes('--dry-run');

const PYRIC = 'packages/pyric';
const RULES = 'packages/rules';
const OLD_SANDBOX = `${PYRIC}/src/storage/sandbox`;
const OLD_RESOLUTION = `${PYRIC}/src/storage/rules-resolution.ts`;
const NEW_DIR = `${RULES}/src/storage`;
const NEW_BARREL = `${RULES}/src/internal/storage.ts`;
const BARREL_SPECIFIER = '@pyric/rules/internal/storage';
const OLD_TEST = `${PYRIC}/test`;
const NEW_TEST = `${RULES}/test`;
const STORAGE_TESTS = `${OLD_TEST}/storage`;
const RULES_TESTS = `${OLD_TEST}/rules`;
const THIS_FILE = 'scripts/codemods/1521-storage-evaluator.ts';

/** Tests whose paths are synthetic fixtures for a path rule, not references to the moved files. */
const SYNTHETIC_PATHS = new Set(['scripts/ci/conformance-coupling-gate.test.ts', 'scripts/rules-boundary-report.test.ts']);

/** The engine's entry files, by the specifier pyric imports them with. */
const ENGINE_ENTRIES: Record<string, string> = {
  '@pyric/rules': `${RULES}/src/index.ts`,
  '@pyric/rules/internal': `${RULES}/src/internal/index.ts`,
  '@pyric/rules/internal/rtdb': `${RULES}/src/internal/rtdb.ts`,
  '@pyric/rules/internal/node': `${RULES}/src/internal/node.ts`,
  'pyric/rules': `${RULES}/src/index.ts`,
  'pyric/rules/internal': `${RULES}/src/internal/index.ts`,
  'pyric/rules/internal/rtdb': `${RULES}/src/internal/rtdb.ts`,
  'pyric/rules/internal/node': `${RULES}/src/internal/node.ts`,
};

const NODE_BUILTINS = new Set(['fs', 'path', 'url', 'os', 'crypto', 'child_process', 'util', 'assert']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.md', '.mdx', '.json', '.yml', '.yaml', '.sh', '.astro', '.txt', '.html']);

const unresolved: string[] = [];
const report = (line: string): void => {
  unresolved.push(line);
};

// ─── git and file helpers ─────────────────────────────────────────────

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const trackedFiles = (): string[] => git(['ls-files', '-z']).split('\0').filter(Boolean);
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const write = (path: string, text: string): void => {
  if (DRY_RUN) return;
  mkdirSync(join(ROOT, dirname(path)), { recursive: true });
  writeFileSync(join(ROOT, path), text);
};
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);
const isCode = (path: string): boolean => CODE_EXTENSIONS.has(extname(path)) && !path.endsWith('.d.ts');
const isTest = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(path);

function gitMove(from: string, to: string): void {
  if (DRY_RUN) return;
  mkdirSync(join(ROOT, dirname(to)), { recursive: true });
  git(['mv', from, to]);
}

// ─── module specifiers ────────────────────────────────────────────────

interface Specifier {
  text: string;
  /** Offsets of the string's contents, without its quotes. */
  start: number;
  end: number;
  statement?: ts.ImportDeclaration | ts.ExportDeclaration;
}

function sourceFile(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

function specifiersOf(path: string, text: string): Specifier[] {
  const file = sourceFile(path, text);
  const found: Specifier[] = [];
  const add = (node: ts.Node | undefined, statement?: Specifier['statement']): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) return;
    found.push({ text: node.text, start: node.getStart(file) + 1, end: node.getEnd() - 1, statement });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier, node);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isMock = ts.isPropertyAccessExpression(callee) && callee.name.text === 'module' && ts.isIdentifier(callee.expression) && callee.expression.text === 'mock';
      if (isImport || isRequire || isMock) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function resolveRelative(fromFile: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stripped = base.replace(/\.(m|c)?js$/, '');
  const candidates = [base, `${stripped}.ts`, `${stripped}.tsx`, `${base}.ts`, `${base}/index.ts`, `${base}.json`];
  return candidates.find((candidate) => files.has(candidate));
}

/** A relative specifier from `fromFile` to `target`, written in the style of `original`. */
function relativeSpecifier(fromFile: string, target: string, original: string): string {
  let path = posix.relative(posix.dirname(fromFile), target);
  if (!path.startsWith('.')) path = `./${path}`;
  const targetExt = extname(target);
  const originalExt = extname(original);
  if (originalExt === targetExt) return path;
  const withoutExt = path.slice(0, path.length - targetExt.length);
  if (originalExt === '') return withoutExt;
  return `${withoutExt}${originalExt}`;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Names a pyric module re-exports from the engine, by the engine specifier it names. */
function engineReExports(path: string): Map<string, string> {
  const file = sourceFile(path, read(path));
  const importedFrom = new Map<string, string>();
  const names = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    const engine = specifier && ts.isStringLiteral(specifier) && specifier.text in ENGINE_ENTRIES ? specifier.text : undefined;
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (engine && bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) importedFrom.set(element.name.text, engine);
      continue;
    }
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      const local = (element.propertyName ?? element.name).text;
      const from = engine ?? (specifier ? undefined : importedFrom.get(local));
      if (from) names.set(element.name.text, from);
    }
  }
  return names;
}

/** The names an import or export statement takes, or undefined for a default or namespace form. */
function namedElements(statement: Specifier['statement']): ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier> | undefined {
  if (!statement) return undefined;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause || clause.name) return undefined;
    const bindings = clause.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
  }
  const clause = statement.exportClause;
  return clause && ts.isNamedExports(clause) ? clause.elements : undefined;
}

// ─── step 1 and 2: what moves ─────────────────────────────────────────

function sourceCandidates(files: ReadonlySet<string>): string[] {
  const isEvaluator = (file: string): boolean => under(file, OLD_SANDBOX) && /\/rules[\w-]*\.ts$/.test(file);
  return [...files].filter((file) => isEvaluator(file) || file === OLD_RESOLUTION);
}

/** Whether a relative import from a candidate only reaches the engine through a pyric re-export. */
function reachesOnlyEngine(target: string, statement: Specifier['statement']): boolean {
  const elements = namedElements(statement);
  if (!elements) return false;
  const reExports = engineReExports(target);
  return elements.every((element) => reExports.has((element.propertyName ?? element.name).text));
}

function planSources(files: ReadonlySet<string>): Map<string, string> {
  const candidates = new Set(sourceCandidates(files));
  const staying = new Set<string>();
  const localImports = new Map<string, string[]>();
  for (const file of candidates) {
    const local: string[] = [];
    for (const { text, statement } of specifiersOf(file, read(file))) {
      if (!text.startsWith('.')) {
        if (!(text in ENGINE_ENTRIES)) staying.add(file);
        continue;
      }
      const target = resolveRelative(file, text, files);
      if (target !== undefined && candidates.has(target)) local.push(target);
      else if (target === undefined || !reachesOnlyEngine(target, statement)) {
        staying.add(file);
        report(`${file}: stays, imports '${text}'`);
      }
    }
    localImports.set(file, local);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of candidates) {
      if (staying.has(file)) continue;
      if ((localImports.get(file) ?? []).some((target) => staying.has(target))) {
        staying.add(file);
        report(`${file}: stays, imports a file that stays`);
        changed = true;
      }
    }
  }
  const moves = new Map<string, string>();
  for (const file of candidates) if (!staying.has(file)) moves.set(file, `${NEW_DIR}/${posix.basename(file)}`);
  return moves;
}

function rulesDependencies(): Set<string> {
  const manifest = JSON.parse(read(`${RULES}/package.json`)) as { dependencies?: object; devDependencies?: object };
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
}

/** A path string into pyric's build, such as `'dist/storage/index.js'`. */
const LOADS_PYRIC_DIST = /['"`/]dist\/[\w-]+\/[\w./-]*\.js['"`]/;

function planTests(files: ReadonlySet<string>, sources: Map<string, string>): Map<string, string> {
  const dependencies = rulesDependencies();
  const tests = [...files].filter((file) => (under(file, STORAGE_TESTS) || under(file, RULES_TESTS)) && isCode(file));
  const reachesPyric = new Set<string>();
  const importsMoved = new Set<string>();
  const localImports = new Map<string, string[]>();
  for (const file of tests) {
    const text = read(file);
    const local: string[] = [];
    for (const { text: specifier } of specifiersOf(file, text)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier, files) ?? posix.normalize(posix.join(posix.dirname(file), specifier));
        if (sources.has(target)) importsMoved.add(file);
        else if (under(target, OLD_TEST)) local.push(target);
        else if (under(target, PYRIC)) reachesPyric.add(file);
      } else if (specifier in ENGINE_ENTRIES) {
        continue;
      } else {
        const isRuntime = specifier.startsWith('node:') || specifier.startsWith('bun:') || NODE_BUILTINS.has(packageName(specifier));
        if (!isRuntime && !dependencies.has(packageName(specifier))) reachesPyric.add(file);
      }
    }
    if (LOADS_PYRIC_DIST.test(text)) reachesPyric.add(file);
    localImports.set(file, local);
  }
  const staying = new Set(reachesPyric);
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of tests) {
      if (staying.has(file)) continue;
      const importsStaying = (localImports.get(file) ?? []).some((target) => staying.has(target) || !tests.includes(target));
      const importers = tests.filter((other) => (localImports.get(other) ?? []).includes(file));
      const onlyStayingImport = !isTest(file) && importers.length > 0 && importers.every((other) => staying.has(other));
      if (importsStaying || onlyStayingImport) {
        staying.add(file);
        changed = true;
      }
    }
  }
  const moves = new Map<string, string>();
  for (const file of tests) {
    if (staying.has(file)) continue;
    const isHelper = !isTest(file);
    const helperUsedByMover = isHelper && tests.some((other) => !staying.has(other) && (localImports.get(other) ?? []).includes(file));
    if (!importsMoved.has(file) && !helperUsedByMover) continue;
    // Storage tests keep their path under the package's test tree; rules tests follow the package move (#2594).
    const inside = under(file, RULES_TESTS) ? file.slice(RULES_TESTS.length + 1) : file.slice(OLD_TEST.length + 1);
    moves.set(file, `${NEW_TEST}/${inside}`);
  }
  return moves;
}

// ─── step 4: imports ──────────────────────────────────────────────────

interface Definition {
  /** The engine module that declares the name. */
  module: string;
  /** The name that module exports it under. */
  name: string;
  isType: boolean;
}

/** Where each name of each engine entry is declared. */
function engineDefinitions(): Map<string, Map<string, Definition>> {
  const entries = [...new Set(Object.values(ENGINE_ENTRIES))];
  const program = ts.createProgram(entries.map((entry) => join(ROOT, entry)), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const ultimate = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const byEntry = new Map<string, Map<string, Definition>>();
  for (const entry of entries) {
    const names = new Map<string, Definition>();
    const source = program.getSourceFile(join(ROOT, entry));
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const symbol = ultimate(exported);
      const declaration = symbol.declarations?.[0];
      if (!declaration) continue;
      const declaringFile = declaration.getSourceFile();
      const declaringModule = checker.getSymbolAtLocation(declaringFile);
      const exportName = declaringModule
        ? checker.getExportsOfModule(declaringModule).find((candidate) => ultimate(candidate) === symbol)?.name
        : undefined;
      if (!exportName) {
        report(`${entry}: cannot find the module that exports '${exported.name}'`);
        continue;
      }
      const module = posix.relative(ROOT, declaringFile.fileName.split('\\').join('/'));
      const isType = (symbol.flags & ts.SymbolFlags.Value) === 0;
      names.set(exported.name, { module, name: exportName, isType });
    }
    byEntry.set(entry, names);
  }
  return byEntry;
}

/** An import or export statement naming an engine entry, rewritten as one statement per declaring module. */
function splitByModule(
  file: string,
  parsed: ts.SourceFile,
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
  definitions: Map<string, Definition>,
): string | undefined {
  const elements = namedElements(statement);
  if (!elements) {
    report(`${file}: '${statement.getText(parsed)}' is a default or namespace form; rewrite it by hand`);
    return undefined;
  }
  const keyword = ts.isImportDeclaration(statement) ? 'import' : 'export';
  const statementIsTypeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
  const quote = statement.moduleSpecifier!.getText(parsed)[0];
  const byModule = new Map<string, string[]>();
  for (const element of elements) {
    const barrelName = (element.propertyName ?? element.name).text;
    const definition = definitions.get(barrelName);
    if (!definition) {
      report(`${file}: no engine entry exports '${barrelName}'`);
      return undefined;
    }
    const local = element.name.text;
    const typePrefix = element.isTypeOnly && !statementIsTypeOnly ? 'type ' : '';
    const binding = definition.name === local ? local : `${definition.name} as ${local}`;
    const parts = byModule.get(definition.module) ?? [];
    parts.push(`${typePrefix}${binding}`);
    byModule.set(definition.module, parts);
  }
  // One declaring module and no renamed name: only the specifier changes, so the statement keeps its layout.
  const keepsNames = elements.every((element) => definitions.get((element.propertyName ?? element.name).text)?.name === (element.propertyName ?? element.name).text);
  if (byModule.size === 1 && keepsNames) {
    const [module] = byModule.keys();
    const specifierText = statement.moduleSpecifier!.getText(parsed);
    return statement.getText(parsed).replace(specifierText, `${quote}${relativeSpecifier(file, module, 'x.js')}${quote}`);
  }
  const lines: string[] = [];
  for (const [module, parts] of byModule) {
    const specifier = relativeSpecifier(file, module, 'x.js');
    lines.push(`${keyword} ${statementIsTypeOnly ? 'type ' : ''}{ ${parts.join(', ')} } from ${quote}${specifier}${quote};`);
  }
  return lines.join('\n');
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(file: string, text: string, edits: Edit[]): void {
  if (edits.length === 0) return;
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (edit.end > lastStart) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  write(file, out);
}

/** In a file now under `packages/rules`, every engine import becomes relative, by declaring module. */
function rewriteMovedFile(file: string, oldFile: string, moves: Map<string, string>, beforeFiles: ReadonlySet<string>, definitions: Map<string, Map<string, Definition>>): void {
  const text = read(file);
  const parsed = sourceFile(file, text);
  const edits: Edit[] = [];
  for (const specifier of specifiersOf(file, text)) {
    const entry = ENGINE_ENTRIES[specifier.text];
    if (entry !== undefined) {
      if (!specifier.statement) {
        report(`${file}: '${specifier.text}' outside an import statement; rewrite it by hand`);
        continue;
      }
      const rewritten = splitByModule(file, parsed, specifier.statement, definitions.get(entry)!);
      if (rewritten !== undefined) edits.push({ start: specifier.statement.getStart(parsed), end: specifier.statement.getEnd(), text: rewritten });
      continue;
    }
    if (!specifier.text.startsWith('.')) continue;
    const oldTarget = resolveRelative(oldFile, specifier.text, beforeFiles);
    if (oldTarget === undefined) continue;
    const newTarget = moves.get(oldTarget);
    if (newTarget !== undefined) {
      const rewritten = relativeSpecifier(file, newTarget, specifier.text);
      if (rewritten !== specifier.text) edits.push({ start: specifier.start, end: specifier.end, text: rewritten });
      continue;
    }
    // A pyric module that re-exports engine names: import them from where the engine declares them.
    const reExports = under(oldTarget, `${PYRIC}/src`) ? engineReExports(oldTarget) : new Map<string, string>();
    const statement = specifier.statement;
    const elements = namedElements(statement);
    const allEngine = statement && elements && elements.every((element) => reExports.has((element.propertyName ?? element.name).text));
    if (allEngine) {
      const merged = new Map<string, Definition>();
      for (const element of elements) {
        const name = (element.propertyName ?? element.name).text;
        const definition = definitions.get(ENGINE_ENTRIES[reExports.get(name)!])?.get(name);
        if (definition) merged.set(name, definition);
      }
      const rewritten = splitByModule(file, parsed, statement, merged);
      if (rewritten !== undefined) edits.push({ start: statement.getStart(parsed), end: statement.getEnd(), text: rewritten });
      continue;
    }
    const rewritten = relativeSpecifier(file, oldTarget, specifier.text);
    if (rewritten !== specifier.text) edits.push({ start: specifier.start, end: specifier.end, text: rewritten });
  }
  applyEdits(file, text, edits);
}

/** In a file that did not move, a path to a moved file becomes the barrel (pyric) or the new path (elsewhere). */
function rewriteCaller(file: string, sources: Map<string, string>, moves: Map<string, string>, beforeFiles: ReadonlySet<string>): void {
  const text = read(file);
  const edits: Edit[] = [];
  for (const specifier of specifiersOf(file, text)) {
    if (!specifier.text.startsWith('.')) continue;
    const oldTarget = resolveRelative(file, specifier.text, beforeFiles);
    if (oldTarget === undefined) continue;
    const newTarget = moves.get(oldTarget);
    if (newTarget === undefined) continue;
    const viaBarrel = under(file, PYRIC) && sources.has(oldTarget);
    const rewritten = viaBarrel ? BARREL_SPECIFIER : relativeSpecifier(file, newTarget, specifier.text);
    edits.push({ start: specifier.start, end: specifier.end, text: rewritten });
  }
  applyEdits(file, text, edits);
}

/** Modules the barrel loads first, in this order; the rest follow by name. */
const LOAD_FIRST = [`${NEW_DIR}/rules.ts`, `${NEW_DIR}/rules-evaluator.ts`];

function byLoadOrder(a: string, b: string): number {
  const rank = (module: string): number => {
    const index = LOAD_FIRST.indexOf(module);
    return index === -1 ? LOAD_FIRST.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

function writeBarrel(sources: Map<string, string>): void {
  if (existsSync(join(ROOT, NEW_BARREL))) return;
  const lines = [
    '/**',
    ' * `@pyric/rules/internal/storage`: the Storage rules parser and evaluator,',
    ' * moved here from pyric (#1521). Unstable: pyric\'s own modules import it.',
    ' *',
    ' * The evaluator\'s modules import each other in a cycle, so the order they',
    ' * load in matters: the parser and the evaluator load first, as they did',
    ' * through pyric\'s `storage/rules.ts`, and the method tables after.',
    ' */',
    ...[...sources.values()].sort(byLoadOrder).map((module) => `export * from '${relativeSpecifier(NEW_BARREL, module, 'x.js')}';`),
  ];
  write(NEW_BARREL, `${lines.join('\n')}\n`);
}

function addBarrelExport(): void {
  const path = `${RULES}/package.json`;
  const text = read(path);
  if (text.includes('"./internal/storage"')) return;
  const anchor = '    "./package.json": "./package.json"';
  const entry = '    "./internal/storage": {\n      "types": "./dist/internal/storage.d.ts",\n      "import": "./dist/internal/storage.js"\n    },\n';
  if (!text.includes(anchor)) {
    report(`${path}: add the ./internal/storage export by hand`);
    return;
  }
  write(path, text.replace(anchor, `${entry}${anchor}`));
}

// ─── step 5: path strings ─────────────────────────────────────────────

function rewritePaths(moves: Map<string, string>, afterFiles: ReadonlySet<string>): void {
  const pairs = [...moves].sort(([a], [b]) => b.length - a.length);
  for (const file of afterFiles) {
    if (file === THIS_FILE || SYNTHETIC_PATHS.has(file) || file.endsWith('CHANGELOG.md') || !TEXT_EXTENSIONS.has(extname(file))) continue;
    if (!existsSync(join(ROOT, file))) continue;
    const text = read(file);
    if (!text.includes('packages/pyric/')) continue;
    let out = text;
    for (const [from, to] of pairs) {
      // A path names a file only when no word character continues it.
      out = out.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), to);
    }
    if (out !== text) write(file, out);
  }
}

// ─── main ─────────────────────────────────────────────────────────────

function main(): void {
  const beforeFiles = new Set(trackedFiles());
  const sources = planSources(beforeFiles);
  const tests = planTests(beforeFiles, sources);
  const moves = new Map([...sources, ...tests]);
  console.log(`moving ${sources.size} source files and ${tests.size} test files`);
  if (DRY_RUN) {
    for (const [from, to] of moves) console.log(`  ${from} -> ${to}`);
    if (unresolved.length > 0) console.log(`\n${unresolved.join('\n')}`);
    return;
  }
  for (const [from, to] of moves) gitMove(from, to);
  writeBarrel(sources);
  addBarrelExport();
  const definitions = engineDefinitions();
  for (const [from, to] of moves) rewriteMovedFile(to, from, moves, beforeFiles, definitions);
  const afterFiles = new Set(trackedFiles());
  const inverse = new Set(moves.values());
  for (const file of afterFiles) {
    if (inverse.has(file) || file === THIS_FILE || !isCode(file) || !existsSync(join(ROOT, file))) continue;
    if (!read(file).includes('rules')) continue;
    rewriteCaller(file, sources, moves, beforeFiles);
  }
  rewritePaths(moves, afterFiles);
  git(['add', '-A', '--', NEW_BARREL, `${RULES}/package.json`]);
  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} notes:`);
    for (const line of unresolved) console.log(`  ${line}`);
  }
}

main();
