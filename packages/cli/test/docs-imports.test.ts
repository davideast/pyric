import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * Every import in a TypeScript or JavaScript code block of the site docs names
 * a real entry and a real export.
 *
 * - The specifier's subpath must be a key of the package's `exports` map, for
 *   `pyric`, `pyric-admin`, and every `@pyric/*` package.
 * - For `pyric` and `pyric-admin`, each imported value name must exist on the
 *   built module (`name in await import(specifier)`). A name the module lacks
 *   at runtime passes only when the entry's declaration file exports it as a
 *   type, so `import { Sandbox }` used in a type position is not a false
 *   failure. `import type` statements and `type`-marked names are skipped.
 *
 * `@pyric/*` entries are checked against the exports map only and never
 * imported: the `@pyric/cli/next/internal/*` entries are browser bundles that
 * load `serve/entries/init.js`, which starts the served runtime on import.
 * Every `pyric` and `pyric-admin` entry loads without side effects in Node and
 * Bun, so none of them is skipped.
 */

const repoRoot = resolve(import.meta.dir, '../../..');
const CONTENT_ROOT = join(repoRoot, 'packages/site-docs/src/content');
const CODE_LANGUAGES = new Set(['ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'mjs']);
const NAME_CHECKED_PACKAGES = new Set(['pyric', 'pyric-admin']);

/**
 * Imported names a guide still uses because the capability it documents has
 * no public entry yet. Keyed `file: name from specifier`; each entry says what
 * the guide is waiting on. An entry that no longer occurs fails the suite, so
 * the list only shrinks.
 */
const UNRESOLVED_NAMES: Record<string, string> = {
  'packages/site-docs/src/content/secure/read-a-denial.md: lintFirestoreRules from pyric/rules':
    'The ruleset-diff lint (`previousSource`, RULES_WEAKENED) is reachable only through pyric/rules/internal; public `lint(source)` takes no previous source.',
};

const requireFromCli =createRequire(join(import.meta.dir, '../package.json'));

interface DocImport {
  file: string;
  line: number;
  specifier: string;
  packageName: string;
  subpath: string;
  names: string[];
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.mdx?$/.test(entry)) out.push(full);
  }
}

interface CodeBlock {
  file: string;
  startLine: number;
  source: string;
}

function codeBlocks(file: string): CodeBlock[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks: CodeBlock[] = [];
  let open: { lang: string; startLine: number; body: string[] } | null = null;
  lines.forEach((line, index) => {
    if (open === null) {
      const fence = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(line);
      if (fence) open = { lang: fence[1].toLowerCase(), startLine: index + 2, body: [] };
      return;
    }
    if (/^\s*```\s*$/.test(line)) {
      if (CODE_LANGUAGES.has(open.lang)) {
        blocks.push({ file, startLine: open.startLine, source: open.body.join('\n') });
      }
      open = null;
      return;
    }
    open.body.push(line);
  });
  return blocks;
}

function packageOf(specifier: string): { packageName: string; subpath: string } | null {
  const match = /^(pyric-admin|pyric|@pyric\/[a-z0-9-]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  return { packageName: match[1], subpath: match[2] ? `.${match[2]}` : '.' };
}

function importsIn(block: CodeBlock): DocImport[] {
  const found: DocImport[] = [];
  const source = ts.createSourceFile('block.tsx', block.source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const owner = packageOf(specifier);
    if (!owner) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    const names: string[] = [];
    if (clause?.name) names.push('default');
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        names.push((element.propertyName ?? element.name).text);
      }
    }
    const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
    found.push({
      file: relative(repoRoot, block.file),
      line: block.startLine + line,
      specifier,
      ...owner,
      names,
    });
  }
  return found;
}

function collectImports(): DocImport[] {
  const files: string[] = [];
  walk(CONTENT_ROOT, files);
  return files.flatMap((file) => codeBlocks(file).flatMap(importsIn));
}

type ExportTarget = string | { [condition: string]: ExportTarget } | null;

function exportsOf(packageName: string): Record<string, ExportTarget> {
  const manifest = requireFromCli(`${packageName}/package.json`) as { exports?: Record<string, ExportTarget> };
  return manifest.exports ?? {};
}

function typesFileOf(packageName: string, subpath: string): string | null {
  const entry = exportsOf(packageName)[subpath];
  if (!entry || typeof entry !== 'object' || typeof entry.types !== 'string') return null;
  return join(dirname(requireFromCli.resolve(`${packageName}/package.json`)), entry.types);
}

const typeExportCache = new Map<string, Set<string>>();

function typeExportsOf(typesFile: string): Set<string> {
  const cached = typeExportCache.get(typesFile);
  if (cached) return cached;
  const program = ts.createProgram([typesFile], { noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(typesFile);
  const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
  const names = new Set<string>();
  if (moduleSymbol) {
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (target.flags & ts.SymbolFlags.Type) names.add(symbol.name);
    }
  }
  typeExportCache.set(typesFile, names);
  return names;
}

describe('docs imports', () => {
  const imports = collectImports();

  test('the scan finds the docs imports', () => {
    expect(imports.length).toBeGreaterThan(20);
  });

  test('every imported subpath is in the package exports map', () => {
    const offenders = imports.filter((entry) => !(entry.subpath in exportsOf(entry.packageName)));
    const message = offenders.map((entry) => `${entry.file}:${entry.line}: ${entry.specifier}`).join('\n');
    expect(offenders, message).toEqual([]);
  });

  async function missingNames(): Promise<Array<{ key: string; at: string }>> {
    const missing: Array<{ key: string; at: string }> = [];
    for (const entry of imports) {
      if (!NAME_CHECKED_PACKAGES.has(entry.packageName)) continue;
      if (!(entry.subpath in exportsOf(entry.packageName))) continue;
      const module = (await import(entry.specifier)) as Record<string, unknown>;
      for (const name of entry.names) {
        if (name in module) continue;
        const typesFile = typesFileOf(entry.packageName, entry.subpath);
        if (typesFile && typeExportsOf(typesFile).has(name)) continue;
        missing.push({
          key: `${entry.file}: ${name} from ${entry.specifier}`,
          at: `${entry.file}:${entry.line}: ${name} from ${entry.specifier}`,
        });
      }
    }
    return missing;
  }

  test('every imported name from pyric and pyric-admin is exported by its entry', async () => {
    const offenders = (await missingNames()).filter((m) => !(m.key in UNRESOLVED_NAMES)).map((m) => m.at);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('every unresolved name still occurs in the docs', async () => {
    const occurring = new Set((await missingNames()).map((m) => m.key));
    const stale = Object.keys(UNRESOLVED_NAMES).filter((key) => !occurring.has(key));
    expect(stale, stale.join('\n')).toEqual([]);
  });
});
