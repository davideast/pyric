#!/usr/bin/env node

/**
 * Check that every package a published `.d.ts` file imports is declared in the
 * package's `dependencies` or `peerDependencies`. A consumer's type checker
 * resolves those imports from its own install, so a declaration that names a
 * dev-only or missing package fails to type-check for that consumer.
 *
 * Usage: node scripts/lib/check-declaration-deps.mjs <package-dir>...
 * Each directory holds a package.json and its published files (an extracted
 * tarball or an installed package).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const BUILTINS = new Set(builtinModules);

export function undeclaredDeclarationImports(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const findings = [];
  for (const file of declarationFiles(packageDir)) {
    const rel = relative(packageDir, file).split(sep).join('/');
    for (const specifier of moduleSpecifiers(file)) {
      const pkg = packageName(specifier);
      if (pkg === null || declared.has(pkg)) continue;
      findings.push(`${rel} -> ${specifier}`);
    }
  }
  return [...new Set(findings)].sort();
}

function declarationFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationFiles(full));
    else if (/\.d\.[cm]?ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The package a bare specifier names, or null for relative paths and Node builtins. */
function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('*')) return null;
  if (specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0])) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function moduleSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `/// <reference types="node" />` names Node's own types, not an npm package.
  const specifiers = sourceFile.typeReferenceDirectives
    .map((ref) => ref.fileName)
    .filter((name) => name !== 'node');
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module 'x'` augments x, which the consumer must still resolve.
      specifiers.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write('usage: node scripts/lib/check-declaration-deps.mjs <package-dir>...\n');
    process.exit(2);
  }
  for (const dir of dirs) {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    const findings = undeclaredDeclarationImports(dir);
    if (findings.length) {
      console.error(`  ✗ ${name} declarations import packages it does not declare as dependencies or peerDependencies:`);
      for (const finding of findings) console.error(`      ${finding}`);
      process.exitCode = 1;
    } else {
      console.log(`  ✓ ${name} declarations import only declared packages`);
    }
  }
}
