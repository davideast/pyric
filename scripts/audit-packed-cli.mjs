#!/usr/bin/env node

/**
 * Audit the installed files from a real @pyric/cli tarball. Repository source
 * and workspace dist output are deliberately not accepted as evidence here.
 *
 * Usage: node scripts/audit-packed-cli.mjs <consumer-dir> <release-contract.json>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';

const [consumerArg, contractArg] = process.argv.slice(2);
if (!consumerArg || !contractArg) {
  process.stderr.write(
    'usage: node scripts/audit-packed-cli.mjs <consumer-dir> <release-contract.json>\n',
  );
  process.exit(2);
}

const consumerDir = isAbsolute(consumerArg) ? consumerArg : resolve(consumerArg);
const contractPath = isAbsolute(contractArg) ? contractArg : resolve(contractArg);
const packageDir = join(consumerDir, 'node_modules/@pyric/cli');
const manifestPath = join(packageDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

assertExact('packed @pyric/cli exports', Object.keys(manifest.exports ?? {}), contract.exports);

const forbiddenPackages = new Set(['firebase', 'firebase-admin']);
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const forbidden = Object.keys(manifest[field] ?? {}).filter((name) =>
    forbiddenPackages.has(name),
  );
  if (forbidden.length > 0) {
    fail(`packed manifest ${field} contains Firebase SDKs: ${forbidden.join(', ')}`);
  }
}

const distDir = join(packageDir, 'dist');
if (!existsSync(distDir)) fail('packed @pyric/cli has no dist directory');
const emitted = readdirSync(distDir, { recursive: true })
  .filter(
    (file) =>
      typeof file === 'string' &&
      (file.endsWith('.js') ||
        file.endsWith('.mjs') ||
        file.endsWith('.cjs') ||
        file.endsWith('.d.ts')),
  )
  .map((file) => join(distDir, file));

const hiddenEdges = emitted.flatMap((file) =>
  moduleSpecifiers(file)
    .filter(isFirebaseSdk)
    .map((specifier) => `${file.slice(packageDir.length + 1)} -> ${specifier}`),
);
assertExact(
  'packed @pyric/cli Firebase SDK import edges',
  hiddenEdges,
  contract.allowedFirebaseSdkImportEdges ?? [],
);

process.stdout.write(
  `  ✓ packed @pyric/cli has exactly ${contract.exports.length} exports and only the pinned Firebase SDK bridge edges\n`,
);

function assertExact(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label} drifted\nexpected: ${expectedSorted.join(', ')}\nactual:   ${actualSorted.join(', ')}`,
    );
  }
}

function moduleSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers = [];
  const addString = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addString(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addString(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addString(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        addString(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isFirebaseSdk(specifier) {
  return (
    specifier === 'firebase' ||
    specifier.startsWith('firebase/') ||
    specifier === 'firebase-admin' ||
    specifier.startsWith('firebase-admin/')
  );
}

function fail(message) {
  throw new Error(message);
}
