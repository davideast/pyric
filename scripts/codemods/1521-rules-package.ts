#!/usr/bin/env bun
/**
 * Moves the rules engine out of `packages/pyric` into `packages/rules`
 * (`@pyric/rules`, #1521 PR 12) and rewrites every reference to the moved
 * files. Checked in so a branch that still adds files under the old paths can
 * merge main and run it again: every step skips what is already done.
 *
 * Run from the repository root:
 *
 *   bun scripts/codemods/1521-rules-package.ts           # move and rewrite
 *   bun scripts/codemods/1521-rules-package.ts --dry-run # print the plan only
 *
 * What it does, in order:
 *
 * 1. Moves (git mv):
 *    - the friendlyeats fixture to `packages/pyric/test/indexes/fixtures/`,
 *      its only user;
 *    - `packages/pyric/src/rules/**` to `packages/rules/src/**`, except the
 *      one-line shims onto pyric's own `rules-production`, `rules-tools` and
 *      `indexes` (KEPT_SOURCE), which stay in pyric;
 *    - each rules-only test under `packages/pyric/test/rules/**` to
 *      `packages/rules/test/**` (see `classifyTests`);
 *    - `packages/pyric/bench/rules/**` to `packages/rules/bench/**`;
 *    - the asset scripts the engine's build runs.
 * 2. Splits the four entry files: the engine copy keeps what the engine
 *    exports, and pyric gets a file at the old path that re-exports
 *    `@pyric/rules` plus pyric's own names, so `pyric/rules` and
 *    `pyric/rules/internal*` keep every name.
 * 3. Rewrites relative imports into or out of the moved files. Pyric's own
 *    modules and tests import the engine by package name through the barrels
 *    (`@pyric/rules/internal`, `/internal/rtdb`, `/internal/node`); a name
 *    no barrel exports yet is added to one.
 * 4. Rewrites path strings that name a moved file (registry rows, corpus,
 *    scripts, docs, workflows).
 *
 * It prints what it could not place, for a hand edit.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '../..');
const DRY_RUN = process.argv.includes('--dry-run');

const PYRIC = 'packages/pyric';
const RULES = 'packages/rules';
const OLD_SRC = `${PYRIC}/src/rules`;
const NEW_SRC = `${RULES}/src`;
const OLD_TEST = `${PYRIC}/test/rules`;
const NEW_TEST = `${RULES}/test`;
const OLD_BENCH = `${PYRIC}/bench/rules`;
const NEW_BENCH = `${RULES}/bench`;
const OLD_FRIENDLYEATS = `${OLD_TEST}/fixtures/firestore-indexes/friendlyeats`;
const NEW_FRIENDLYEATS = `${PYRIC}/test/indexes/fixtures/friendlyeats`;

/** Shims onto pyric's own modules, and the extractor entry: they stay in pyric. */
const KEPT_SOURCE = new Set([
  'inspect/handler.ts',
  'test/handler.ts',
  'write/handler.ts',
  'inspect/tools.ts',
  'stdlib-tools.ts',
  'tools.ts',
  'simulator-tools-impl.ts',
  'simulator.ts',
  'indexes/extract/composite.ts',
  'indexes/extract/extractor.ts',
  'indexes/extract/types.ts',
  'indexes/extractHandler.ts',
  'indexes/extractTool.ts',
  'indexes/types.ts',
  'internal/extract.ts',
]);

/** The engine's entry files, by the subpath each one becomes. */
const ENTRIES: Record<string, string> = {
  'index.ts': '@pyric/rules',
  'internal/index.ts': '@pyric/rules/internal',
  'internal/rtdb.ts': '@pyric/rules/internal/rtdb',
  'internal/node.ts': '@pyric/rules/internal/node',
};

/** Test data that only tests staying in pyric read. */
const KEPT_TEST_DATA = ['grammar/fixtures/size-limits/'];

/** Files outside the three trees that move with the engine. */
const MOVED_FILES: Record<string, string> = {
  [`${PYRIC}/scripts/inline-grammar-rules.ts`]: `${RULES}/scripts/inline-grammar-rules.ts`,
  [`${PYRIC}/scripts/inline-stdlib.ts`]: `${RULES}/scripts/inline-stdlib.ts`,
  [`${PYRIC}/scripts/stdlib-service-contract.ts`]: `${RULES}/scripts/stdlib-service-contract.ts`,
  [`${PYRIC}/scripts/copy-assets.ts`]: `${RULES}/scripts/copy-assets.ts`,
  [`${PYRIC}/test/scripts/stdlib-service-contract.test.ts`]: `${RULES}/test/scripts/stdlib-service-contract.test.ts`,
};

/** Bare specifiers a moved test uses for the engine, and what they become. */
const ENGINE_PACKAGE_SPECIFIERS: Record<string, string> = {
  'pyric/rules': '@pyric/rules',
  'pyric/rules/internal': '@pyric/rules/internal',
  'pyric/rules/internal/rtdb': '@pyric/rules/internal/rtdb',
  'pyric/rules/internal/node': '@pyric/rules/internal/node',
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.md', '.mdx', '.json', '.yml', '.yaml', '.sh', '.astro', '.swift', '.kt', '.dart', '.txt', '.html']);
const THIS_FILE = 'scripts/codemods/1521-rules-package.ts';

const unresolved: string[] = [];
const report = (line: string): void => {
  unresolved.push(line);
};

// ─── git helpers ──────────────────────────────────────────────────────

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function trackedFiles(): string[] {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function gitMove(from: string, to: string): void {
  if (DRY_RUN) return;
  mkdirSync(join(ROOT, dirname(to)), { recursive: true });
  git(['mv', '-f', from, to]);
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const write = (path: string, text: string): void => {
  if (DRY_RUN) return;
  mkdirSync(join(ROOT, dirname(path)), { recursive: true });
  writeFileSync(join(ROOT, path), text);
};

const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);
const isCode = (path: string): boolean => CODE_EXTENSIONS.has(extname(path)) && !path.endsWith('.d.ts');

// ─── module specifiers ────────────────────────────────────────────────

interface Specifier {
  text: string;
  /** Offsets of the string's contents, without its quotes. */
  start: number;
  end: number;
  /** The import or export statement, when the specifier belongs to one. */
  statement?: ts.ImportDeclaration | ts.ExportDeclaration;
}

function sourceFile(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every module specifier a file names, as written. */
function specifiersOf(path: string, text: string): Specifier[] {
  const file = sourceFile(path, text);
  const found: Specifier[] = [];
  const add = (node: ts.Node | undefined, statement?: Specifier['statement']): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) return;
    found.push({ text: node.text, start: node.getStart(file) + 1, end: node.getEnd() - 1, statement });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier, node);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
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

/** The repo path a relative specifier names, among `files`, or undefined. */
function resolveRelative(fromFile: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stripped = base.replace(/\.(m|c)?js$/, '');
  const candidates = [base, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.js`, `${base}.json`];
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
  if (originalExt === '') return original.endsWith('/') || original.endsWith('/index') ? path : withoutExt.replace(/\/index$/, '');
  return `${withoutExt}${originalExt}`;
}

// ─── step 1: moves ────────────────────────────────────────────────────

/**
 * A test stays in pyric if it imports pyric outside the engine: a relative
 * path into `packages/pyric` outside `src/rules` and `test/rules`, a kept
 * shim, a `pyric*` or `@pyric/*` package other than the four engine entries,
 * or the Firebase SDK. A test importing a staying helper stays too, and a
 * helper only staying tests import stays with them.
 */
function classifyTests(files: ReadonlySet<string>): { moving: string[]; staying: string[] } {
  const tests = [...files].filter((file) => under(file, OLD_TEST) && !under(file, OLD_FRIENDLYEATS));
  const code = tests.filter(isCode);
  const reachesPyric = new Set<string>();
  const imports = new Map<string, string[]>();
  for (const file of code) {
    const local: string[] = [];
    for (const { text } of specifiersOf(file, read(file))) {
      if (text.startsWith('.')) {
        const target = resolveRelative(file, text, files) ?? posix.normalize(posix.join(posix.dirname(file), text));
        if (under(target, OLD_TEST)) local.push(target);
        else if (under(target, OLD_SRC)) {
          if (KEPT_SOURCE.has(target.slice(OLD_SRC.length + 1))) reachesPyric.add(file);
        } else if (under(target, PYRIC) && target !== `${PYRIC}/package.json`) reachesPyric.add(file);
      } else if (/^(pyric|pyric-admin|create-pyric|@pyric|firebase|firebase-admin)(\/|$)/.test(text) && !(text in ENGINE_PACKAGE_SPECIFIERS)) {
        reachesPyric.add(file);
      }
    }
    imports.set(file, local);
  }
  const staying = new Set(reachesPyric);
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of code) {
      if (staying.has(file)) continue;
      const importsStaying = (imports.get(file) ?? []).some((target) => staying.has(target));
      const importers = code.filter((other) => (imports.get(other) ?? []).includes(file));
      const isHelper = !/\.test\.[cm]?[jt]sx?$/.test(file);
      const onlyStayingImport = isHelper && importers.length > 0 && importers.every((other) => staying.has(other));
      if (importsStaying || onlyStayingImport) {
        staying.add(file);
        changed = true;
      }
    }
  }
  for (const file of tests) {
    const isKeptData = !isCode(file) && KEPT_TEST_DATA.some((prefix) => file.startsWith(`${OLD_TEST}/${prefix}`));
    if (isKeptData) staying.add(file);
  }
  return { moving: tests.filter((file) => !staying.has(file)), staying: [...staying].filter((file) => under(file, OLD_TEST)) };
}

function planMoves(files: ReadonlySet<string>): Map<string, string> {
  const moves = new Map<string, string>();
  for (const file of files) {
    if (under(file, OLD_FRIENDLYEATS)) moves.set(file, `${NEW_FRIENDLYEATS}/${file.slice(OLD_FRIENDLYEATS.length + 1)}`);
    else if (under(file, OLD_SRC) && !KEPT_SOURCE.has(file.slice(OLD_SRC.length + 1))) moves.set(file, `${NEW_SRC}/${file.slice(OLD_SRC.length + 1)}`);
    else if (under(file, OLD_BENCH)) moves.set(file, `${NEW_BENCH}/${file.slice(OLD_BENCH.length + 1)}`);
    else if (file in MOVED_FILES) moves.set(file, MOVED_FILES[file]);
  }
  for (const file of classifyTests(files).moving) moves.set(file, `${NEW_TEST}/${file.slice(OLD_TEST.length + 1)}`);
  return moves;
}

// ─── step 2: entry files ──────────────────────────────────────────────

/**
 * Removes from the moved engine entry each export that names a kept pyric
 * module, and writes pyric's entry at the old path: a re-export of the engine
 * entry plus those statements.
 */
function splitEntry(entry: string, subpath: string, beforeFiles: ReadonlySet<string>): void {
  const oldPath = `${OLD_SRC}/${entry}`;
  const newPath = `${NEW_SRC}/${entry}`;
  const pyricHasEntry = existsSync(join(ROOT, oldPath)) && read(oldPath).includes(`from '${subpath}'`);
  if (pyricHasEntry || !existsSync(join(ROOT, newPath))) return;
  const text = read(newPath);
  const file = sourceFile(newPath, text);
  const kept: string[] = [];
  const cuts: Array<[number, number]> = [];
  for (const statement of file.statements) {
    const isReExportOrImport = (ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier);
    if (!isReExportOrImport) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!specifier.startsWith('.')) continue;
    const target = resolveRelative(oldPath, specifier, beforeFiles);
    const isPyricOwn = target !== undefined && under(target, OLD_SRC) && KEPT_SOURCE.has(target.slice(OLD_SRC.length + 1));
    if (!isPyricOwn) continue;
    kept.push(text.slice(statement.getFullStart(), statement.getEnd()).replace(/^\n+/, ''));
    cuts.push([statement.getFullStart(), statement.getEnd()]);
  }
  let engine = text;
  for (const [start, end] of cuts.reverse()) engine = engine.slice(0, start) + engine.slice(end);
  write(newPath, engine);
  const header = [
    '/**',
    ` * \`pyric/rules${subpath.slice('@pyric/rules'.length)}\`: the engine moved to \`${subpath}\` (#1521).`,
    ' * This entry re-exports it, so every name it had keeps resolving here.',
    kept.length > 0 ? ' * The names below are pyric\'s own and stay in this package.' : undefined,
    ' */',
  ].filter((line) => line !== undefined);
  write(oldPath, `${header.join('\n')}\nexport * from '${subpath}';\n${kept.length > 0 ? `\n${kept.join('\n')}\n` : ''}`);
}

// ─── step 3: imports ──────────────────────────────────────────────────

/** Where pyric imports an engine module's names from, by barrel. */
interface BarrelIndex {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Barrel subpath -> exported name -> the symbol it resolves to. */
  exports: Map<string, Map<string, ts.Symbol>>;
  /** Barrel subpath -> lines to append. */
  additions: Map<string, Map<string, { values: Set<string>; types: Set<string> }>>;
}

const BARREL_FILES: Record<string, string> = {
  '@pyric/rules/internal': 'internal/index.ts',
  '@pyric/rules/internal/rtdb': 'internal/rtdb.ts',
  '@pyric/rules/internal/node': 'internal/node.ts',
  '@pyric/rules': 'index.ts',
};

function ultimate(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function buildBarrelIndex(afterFiles: ReadonlySet<string>): BarrelIndex {
  // Every engine module is a root, so one checker answers for all of them and
  // the symbols it hands out compare by identity.
  const engineModules = [...afterFiles].filter((file) => under(file, NEW_SRC) && file.endsWith('.ts') && !file.endsWith('.d.ts'));
  const rootNames = engineModules.map((file) => join(ROOT, file));
  const program = ts.createProgram(rootNames, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const exports = new Map<string, Map<string, ts.Symbol>>();
  for (const [subpath, file] of Object.entries(BARREL_FILES)) {
    const source = program.getSourceFile(join(ROOT, NEW_SRC, file));
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    const names = new Map<string, ts.Symbol>();
    if (moduleSymbol) for (const symbol of checker.getExportsOfModule(moduleSymbol)) names.set(symbol.name, ultimate(checker, symbol));
    exports.set(subpath, names);
  }
  return { program, checker, exports, additions: new Map() };
}

/** The exported names of an engine module, each with its symbol. */
function moduleExports(index: BarrelIndex, enginePath: string): Map<string, ts.Symbol> {
  const source = index.program.getSourceFile(join(ROOT, enginePath));
  const moduleSymbol = source && index.checker.getSymbolAtLocation(source);
  const names = new Map<string, ts.Symbol>();
  if (moduleSymbol) for (const symbol of index.checker.getExportsOfModule(moduleSymbol)) names.set(symbol.name, ultimate(index.checker, symbol));
  return names;
}

/** The barrel a module's names go to when no barrel exports them yet. */
function defaultBarrel(enginePath: string): string[] {
  const inside = enginePath.slice(NEW_SRC.length + 1);
  if (inside.startsWith('modules/resolver.') || inside.startsWith('rtdb/constraints/write-rules-file.')) return ['@pyric/rules/internal/node'];
  if (inside.startsWith('rtdb/')) return ['@pyric/rules/internal/rtdb', '@pyric/rules/internal'];
  return ['@pyric/rules/internal', '@pyric/rules/internal/rtdb'];
}

/** The barrel that exports `name` from `enginePath`, adding it to one when none does. */
function barrelFor(index: BarrelIndex, enginePath: string, name: string, where: string): string | undefined {
  const symbol = moduleExports(index, enginePath).get(name);
  if (!symbol) {
    report(`${where}: ${enginePath} exports no '${name}'`);
    return undefined;
  }
  const preferred = [...defaultBarrel(enginePath), '@pyric/rules/internal', '@pyric/rules/internal/rtdb', '@pyric/rules/internal/node', '@pyric/rules'];
  for (const subpath of preferred) if (index.exports.get(subpath)?.get(name) === symbol) return subpath;
  for (const subpath of defaultBarrel(enginePath)) {
    const taken = index.exports.get(subpath)?.get(name);
    if (taken !== undefined && taken !== symbol) continue;
    index.exports.get(subpath)?.set(name, symbol);
    const byModule = index.additions.get(subpath) ?? new Map();
    index.additions.set(subpath, byModule);
    const entry = byModule.get(enginePath) ?? { values: new Set<string>(), types: new Set<string>() };
    byModule.set(enginePath, entry);
    const isValue = (symbol.flags & ts.SymbolFlags.Value) !== 0;
    (isValue ? entry.values : entry.types).add(name);
    return subpath;
  }
  report(`${where}: '${name}' from ${enginePath} collides with another export of every barrel it could go in`);
  return undefined;
}

/** The names an import or export statement takes, or undefined for a form the barrels cannot serve. */
function statementNames(index: BarrelIndex, statement: ts.ImportDeclaration | ts.ExportDeclaration, enginePath: string): string[] | undefined {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return undefined;
    if (clause.name) return undefined;
    const bindings = clause.namedBindings;
    if (!bindings) return [];
    if (ts.isNamespaceImport(bindings)) return undefined;
    return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
  }
  if (!statement.exportClause) return [...moduleExports(index, enginePath).keys()];
  if (ts.isNamespaceExport(statement.exportClause)) return undefined;
  return statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text);
}

/** One statement per barrel, each taking that barrel's share of the names. */
function splitStatement(index: BarrelIndex, statement: ts.ImportDeclaration | ts.ExportDeclaration, file: ts.SourceFile, byBarrel: Map<string, Set<string>>, enginePath: string): string {
  const text = statement.getText(file);
  const specifierText = (statement.moduleSpecifier as ts.StringLiteral).getText(file);
  const quote = specifierText[0];
  const isExportStar = ts.isExportDeclaration(statement) && !statement.exportClause;
  if (byBarrel.size === 1 && !isExportStar) {
    const [subpath] = byBarrel.keys();
    return text.replace(specifierText, `${quote}${subpath}${quote}`);
  }
  const elements = new Map<string, string>();
  const named = ts.isImportDeclaration(statement)
    ? (statement.importClause?.namedBindings as ts.NamedImports | undefined)?.elements
    : (statement.exportClause as ts.NamedExports | undefined)?.elements;
  for (const element of named ?? []) elements.set((element.propertyName ?? element.name).text, element.getText(file));
  const statementIsTypeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
  const keyword = ts.isImportDeclaration(statement) ? 'import' : 'export';
  const lines: string[] = [];
  const exportsOfModule = moduleExports(index, enginePath);
  for (const [subpath, names] of byBarrel) {
    if (isExportStar) {
      const values = [...names].filter((name) => ((exportsOfModule.get(name)?.flags ?? 0) & ts.SymbolFlags.Value) !== 0);
      const types = [...names].filter((name) => !values.includes(name));
      if (values.length > 0) lines.push(`export { ${values.join(', ')} } from ${quote}${subpath}${quote};`);
      if (types.length > 0) lines.push(`export type { ${types.join(', ')} } from ${quote}${subpath}${quote};`);
      continue;
    }
    const parts = [...names].map((name) => elements.get(name) ?? name);
    lines.push(`${keyword} ${statementIsTypeOnly ? 'type ' : ''}{ ${parts.join(', ')} } from ${quote}${subpath}${quote};`);
  }
  return lines.join('\n');
}

/** Whether a file imports the engine by package name rather than by path. */
const importsEngineByPackage = (file: string): boolean => under(file, PYRIC);

function rewriteImports(moves: Map<string, string>, beforeFiles: ReadonlySet<string>, afterFiles: ReadonlySet<string>): void {
  const inverse = new Map([...moves].map(([from, to]) => [to, from]));
  let index: BarrelIndex | undefined;
  const barrelIndex = (): BarrelIndex => (index ??= buildBarrelIndex(afterFiles));
  const codeFiles = [...afterFiles].filter((file) => isCode(file) && file !== THIS_FILE && existsSync(join(ROOT, file)));
  for (const file of codeFiles) {
    const oldFile = inverse.get(file) ?? file;
    const text = read(file);
    // Every path into a moved tree names a `rules` directory.
    if (!inverse.has(file) && !text.includes('rules')) continue;
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const parsed = sourceFile(file, text);
    for (const specifier of specifiersOf(file, text)) {
      if (!specifier.text.startsWith('.')) {
        const engineSpecifier = ENGINE_PACKAGE_SPECIFIERS[specifier.text];
        if (engineSpecifier && inverse.has(file) && under(file, NEW_TEST)) edits.push({ start: specifier.start, end: specifier.end, text: engineSpecifier });
        continue;
      }
      const oldTarget = resolveRelative(oldFile, specifier.text, beforeFiles);
      if (oldTarget === undefined) {
        // Already rewritten on an earlier run, or never resolved: leave it.
        if (inverse.has(file) && resolveRelative(file, specifier.text, afterFiles) === undefined) report(`${file}: cannot resolve '${specifier.text}'`);
        continue;
      }
      // A moved test reading the package manifest reads the engine's now.
      const readsManifest = inverse.has(file) && oldTarget === `${PYRIC}/package.json`;
      const newTarget = readsManifest ? `${RULES}/package.json` : (moves.get(oldTarget) ?? oldTarget);
      const pyricEntry = under(oldTarget, OLD_SRC) && oldTarget.slice(OLD_SRC.length + 1) in ENTRIES;
      if (importsEngineByPackage(file) && pyricEntry) {
        // Pyric keeps an entry file at the old path.
        if (inverse.has(file)) edits.push({ start: specifier.start, end: specifier.end, text: relativeSpecifier(file, oldTarget, specifier.text) });
        continue;
      }
      if (importsEngineByPackage(file) && under(newTarget, NEW_SRC)) {
        const statement = specifier.statement;
        if (!statement) {
          report(`${file}: '${specifier.text}' is not an import or export statement; point it at a barrel by hand`);
          continue;
        }
        const names = statementNames(barrelIndex(), statement, newTarget);
        if (names === undefined) {
          report(`${file}: '${statement.getText(parsed)}' is a default or namespace form; rewrite it by hand`);
          continue;
        }
        const byBarrel = new Map<string, Set<string>>();
        for (const name of names) {
          const subpath = barrelFor(barrelIndex(), newTarget, name, file);
          if (subpath === undefined) continue;
          const set = byBarrel.get(subpath) ?? new Set<string>();
          set.add(name);
          byBarrel.set(subpath, set);
        }
        if (names.length === 0) byBarrel.set(defaultBarrel(newTarget)[0], new Set());
        if (byBarrel.size === 0) continue;
        edits.push({ start: statement.getStart(parsed), end: statement.getEnd(), text: splitStatement(barrelIndex(), statement, parsed, byBarrel, newTarget) });
        continue;
      }
      if (newTarget === oldTarget && oldFile === file) continue;
      const rewritten = relativeSpecifier(file, newTarget, specifier.text);
      if (rewritten !== specifier.text) edits.push({ start: specifier.start, end: specifier.end, text: rewritten });
    }
    applyEdits(file, text, edits);
  }
  if (index) writeBarrelAdditions(index);
}

function applyEdits(file: string, text: string, edits: Array<{ start: number; end: number; text: string }>): void {
  if (edits.length === 0) return;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) continue; // a statement edit already covers this specifier
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  write(file, out);
}

function writeBarrelAdditions(index: BarrelIndex): void {
  for (const [subpath, byModule] of index.additions) {
    const barrel = `${NEW_SRC}/${BARREL_FILES[subpath]}`;
    const lines = [
      '',
      '// Names pyric\'s own modules import from the engine, re-exported here when',
      '// the engine moved into this package (#1521). Unstable, like the rest of',
      '// this entry.',
    ];
    for (const [enginePath, { values, types }] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
      const specifier = relativeSpecifier(barrel, enginePath, 'x.js');
      if (values.size > 0) lines.push(`export { ${[...values].sort().join(', ')} } from '${specifier}';`);
      if (types.size > 0) lines.push(`export type { ${[...types].sort().join(', ')} } from '${specifier}';`);
    }
    write(barrel, `${read(barrel).replace(/\n*$/, '\n')}${lines.join('\n')}\n`);
  }
}

// ─── step 4: path strings ─────────────────────────────────────────────

const PATH_PATTERN = /packages\/pyric\/(src|test|bench)\/rules(?![A-Za-z0-9_-])((?:\/[A-Za-z0-9_.*{},@-]+)*\/?)/g;
const SEGMENT_PATTERN = /'packages',\s*'pyric',\s*'(src|test|bench)',\s*'rules'((?:,\s*'[^']+')*)/g;
const SCRIPT_PATTERN = /packages\/pyric\/(scripts\/(?:inline-grammar-rules|inline-stdlib|stdlib-service-contract|copy-assets)\.ts|test\/scripts\/stdlib-service-contract\.test\.ts)/g;

/** Where a path string under one of the three trees points now, or undefined to leave it. */
function mapPath(tree: string, rest: string, moves: Map<string, string>, afterFiles: ReadonlySet<string>, where: string): string | undefined {
  const inside = rest.replace(/^\//, '');
  const isGlobOrDir = inside === '' || inside.endsWith('/') || /[*{]/.test(inside) || !extname(inside);
  if (tree === 'bench') return `${NEW_BENCH}${rest}`;
  if (tree === 'src') {
    if (KEPT_SOURCE.has(inside)) return undefined;
    return `${NEW_SRC}${rest}`;
  }
  const oldPath = `${OLD_TEST}/${inside}`;
  if (under(`${oldPath}/`, OLD_FRIENDLYEATS) || oldPath === OLD_FRIENDLYEATS || under(oldPath, OLD_FRIENDLYEATS)) {
    return `${NEW_FRIENDLYEATS}${oldPath.slice(OLD_FRIENDLYEATS.length)}`;
  }
  if (!isGlobOrDir) {
    const moved = moves.get(oldPath);
    if (moved) return moved;
    if (afterFiles.has(oldPath)) return undefined;
    if (afterFiles.has(`${NEW_TEST}/${inside}`)) return `${NEW_TEST}/${inside}`;
    report(`${where}: path ${OLD_TEST}/${inside} names no file`);
    return undefined;
  }
  const prefix = inside.replace(/[*{].*$/, '').replace(/\/?$/, '/');
  const dirPrefix = prefix === '/' ? '' : prefix;
  const oldLeft = [...afterFiles].some((file) => file.startsWith(`${OLD_TEST}/${dirPrefix}`));
  const newHas = [...afterFiles].some((file) => file.startsWith(`${NEW_TEST}/${dirPrefix}`));
  if (newHas && !oldLeft) return `${NEW_TEST}${rest}`;
  if (newHas && oldLeft) report(`${where}: ${OLD_TEST}${rest} is split between pyric and @pyric/rules; edit by hand`);
  return undefined;
}

function rewritePaths(moves: Map<string, string>, afterFiles: ReadonlySet<string>): void {
  for (const file of afterFiles) {
    if (file === THIS_FILE || file.endsWith('CHANGELOG.md') || !TEXT_EXTENSIONS.has(extname(file))) continue;
    if (!existsSync(join(ROOT, file))) continue;
    const text = read(file);
    if (!text.includes('packages/pyric/') && !text.includes("'packages', 'pyric'")) continue;
    let out = text.replace(PATH_PATTERN, (match, tree: string, rawRest: string) => {
      // A sentence's full stop is not part of the path.
      const trail = /\.+$/.exec(rawRest)?.[0] ?? '';
      const rest = rawRest.slice(0, rawRest.length - trail.length);
      const mapped = mapPath(tree, rest, moves, afterFiles, file);
      return mapped === undefined ? match : `${mapped}${trail}`;
    });
    out = out.replace(SEGMENT_PATTERN, (match, tree: string, segments: string) => {
      const rest = segments.split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
      const mapped = mapPath(tree, rest.length > 0 ? `/${rest.join('/')}` : '', moves, afterFiles, file);
      if (mapped === undefined) return match;
      return mapped.split('/').map((part) => `'${part}'`).join(', ');
    });
    out = out.replace(SCRIPT_PATTERN, (match) => MOVED_FILES[match] ?? match);
    if (out !== text) write(file, out);
  }
}

// ─── main ─────────────────────────────────────────────────────────────

function main(): void {
  const beforeFiles = new Set(trackedFiles());
  const moves = planMoves(beforeFiles);
  console.log(`moving ${moves.size} files`);
  if (DRY_RUN) {
    for (const [from, to] of moves) console.log(`  ${from} -> ${to}`);
    return;
  }
  for (const [from, to] of moves) gitMove(from, to);
  for (const [entry, subpath] of Object.entries(ENTRIES)) splitEntry(entry, subpath, beforeFiles);
  if (!DRY_RUN) git(['add', '-A', '--', OLD_SRC, NEW_SRC]);
  const afterFiles = new Set(trackedFiles());
  rewriteImports(moves, beforeFiles, afterFiles);
  rewritePaths(moves, afterFiles);
  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} references to edit by hand:`);
    for (const line of unresolved) console.log(`  ${line}`);
  }
}

main();
