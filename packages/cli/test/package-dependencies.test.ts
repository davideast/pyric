import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const workspaceRoot = join(import.meta.dir, '../../..');
const packageDirs = ['packages/cli', 'packages/create-pyric', 'packages/pyric', 'packages/pyric-admin'];
const forbiddenPackages = new Set(['firebase', 'firebase-admin']);

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
}

function manifest(packageDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(workspaceRoot, packageDir, 'package.json'), 'utf8')) as PackageManifest;
}

function emittedFiles(packageDir: string): string[] {
  const dist = join(workspaceRoot, packageDir, 'dist');
  if (!existsSync(dist)) throw new Error(`${packageDir}/dist is missing; build before running this gate`);
  return (readdirSync(dist, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
    .map((file) => join(dist, file));
}

function moduleSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];
  const addString = (node: ts.Expression | ts.TypeNode | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addString(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) addString(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addString(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') addString(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isFirebaseSdk(specifier: string): boolean {
  return specifier === 'firebase' || specifier.startsWith('firebase/') ||
    specifier === 'firebase-admin' || specifier.startsWith('firebase-admin/');
}

describe('@pyric/cli published dependency closure', () => {
  it('declares both sandbox mirrors and no Firebase SDK runtime dependency', () => {
    const cli = manifest('packages/cli');
    expect(cli.dependencies?.pyric).toBeDefined();
    expect(cli.dependencies?.['pyric-admin']).toBeDefined();

    for (const packageDir of packageDirs) {
      const pkg = manifest(packageDir);
      const forbidden = Object.keys(pkg.dependencies ?? {}).filter((name) => forbiddenPackages.has(name));
      expect(forbidden, `${pkg.name} runtime dependencies`).toEqual([]);
    }
  });

  it('has no emitted runtime or declaration edge to either Firebase SDK', () => {
    const edges = packageDirs.flatMap((packageDir) =>
      emittedFiles(packageDir).flatMap((file) =>
        moduleSpecifiers(file)
          .filter(isFirebaseSdk)
          .map((specifier) => `${file.slice(workspaceRoot.length + 1)} -> ${specifier}`),
      ),
    );
    expect(edges).toEqual([]);
  });
});
