/**
 * The public surface of the installed `firebase-admin`, read from its type
 * declarations with the TypeScript compiler API.
 *
 * Two shapes are read:
 *   - the runtime value exports of one entry point (functions, classes,
 *     enums, constants and namespaces; type-only exports have no runtime
 *     form and are skipped), following re-exports into
 *     `@google-cloud/firestore` and `@firebase/database-types`;
 *   - the public members of a type reached from an export by a path of
 *     calls and property reads, such as `getStorage` then `bucket` then
 *     `file` for the `@google-cloud/storage` `File` a bucket hands out.
 *
 * Members that are `private` or `protected`, and names the upstream packages
 * mark internal by convention (a leading or trailing `_`), are not public
 * surface and are skipped.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed `firebase-admin` package root. */
function firebaseAdminRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve('firebase-admin')));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === 'firebase-admin') return dir;
    } catch { /* not a package root */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('firebase-admin package root not found');
    dir = parent;
  }
}

/** The installed `firebase-admin` version. */
export function firebaseAdminVersion(): string {
  return (JSON.parse(readFileSync(join(firebaseAdminRoot(), 'package.json'), 'utf8')) as { version: string }).version;
}

/** The declaration file of one entry point; `.` is the package root. */
function entryDeclaration(root: string, entry: string): string {
  return entry === '.' ? join(root, 'lib', 'default-namespace.d.ts') : join(root, 'lib', entry, 'index.d.ts');
}

/**
 * One step of a path from an entry export to a type.
 *   - a name: read that member (or export, for the first step); a callable
 *     result steps to its return type, a class to its instance type;
 *   - `{ static: name }` on the first step: the class or namespace value
 *     itself (its static members), not its instance type;
 *   - `{ awaited: name }`: as a name, then unwrap a `Promise` and take the
 *     first element of a tuple result (`Promise<[Bucket]>` steps to `Bucket`).
 */
export type PathStep = string | { static: string } | { awaited: string };

/**
 * How a caller uses one member: a `property` is read, a `sync` method returns
 * a plain value, an `async` method has a call form that returns a promise.
 */
export type MemberKind = 'property' | 'sync' | 'async';

export interface UpstreamSurface {
  /** The runtime value exports of `entry`. */
  exports(entry: string): string[];
  /** The public members of the type `path` reaches from `entry`, by name. */
  members(entry: string, path: readonly PathStep[]): Map<string, MemberKind>;
}

/** Whether a member name is internal by the upstream packages' convention. */
function isInternalName(name: string): boolean {
  return name.startsWith('_') || name.endsWith('_') || name.startsWith('#');
}

/** Load the declarations of every listed entry point into one program. */
export function loadUpstreamSurface(entries: readonly string[]): UpstreamSurface {
  const root = firebaseAdminRoot();
  const files = new Map(entries.map((entry) => [entry, entryDeclaration(root, entry)]));
  const program = ts.createProgram([...files.values()], {
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();

  const resolve = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const exportSymbols = (entry: string): ts.Symbol[] => {
    const file = files.get(entry);
    if (!file) throw new Error(`entry '${entry}' was not loaded`);
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`no declarations at ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${file} is not a module`);
    return checker.getExportsOfModule(moduleSymbol);
  };

  const unwrap = (type: ts.Type): ts.Type => {
    const awaited = checker.getAwaitedType(type) ?? type;
    if (checker.isTupleType(awaited)) {
      const [first] = checker.getTypeArguments(awaited as ts.TypeReference);
      if (first) return first;
    }
    return awaited;
  };

  const step = (type: ts.Type, name: string): ts.Type => {
    const property = type.getProperty(name);
    if (!property) throw new Error(`no member '${name}' on ${checker.typeToString(type)}`);
    return valueOrResult(checker.getTypeOfSymbol(property));
  };

  const valueOrResult = (type: ts.Type): ts.Type => {
    const [signature] = type.getCallSignatures();
    if (signature) return checker.getReturnTypeOfSignature(signature);
    const [construct] = type.getConstructSignatures();
    if (construct) return checker.getReturnTypeOfSignature(construct);
    return type;
  };

  const kindOf = (property: ts.Symbol): MemberKind => {
    if (!(property.flags & ts.SymbolFlags.Method)) return 'property';
    const signatures = checker.getTypeOfSymbol(property).getCallSignatures();
    const returnsPromise = signatures.some((signature) => {
      const result = checker.getReturnTypeOfSignature(signature);
      return checker.getAwaitedType(result) !== result;
    });
    return returnsPromise ? 'async' : 'sync';
  };

  return {
    exports(entry) {
      return exportSymbols(entry)
        .filter((symbol) => resolve(symbol).flags & ts.SymbolFlags.Value)
        .map((symbol) => symbol.name)
        .sort();
    },

    members(entry, path) {
      const [first, ...rest] = path;
      if (first === undefined) throw new Error('empty path');
      const firstName = typeof first === 'string' ? first : 'static' in first ? first.static : first.awaited;
      const exported = exportSymbols(entry).find((symbol) => symbol.name === firstName);
      if (!exported) throw new Error(`'${entry}' does not export '${firstName}'`);
      const symbol = resolve(exported);
      let type: ts.Type;
      if (typeof first === 'object' && 'static' in first) {
        type = checker.getTypeOfSymbol(symbol);
      } else if (symbol.flags & ts.SymbolFlags.Class) {
        type = checker.getDeclaredTypeOfSymbol(symbol);
      } else {
        type = valueOrResult(checker.getTypeOfSymbol(symbol));
      }
      if (typeof first === 'object' && 'awaited' in first) type = unwrap(type);
      for (const next of rest) {
        if (typeof next === 'string') type = step(type, next);
        else if ('awaited' in next) type = unwrap(step(type, next.awaited));
        else throw new Error('a static step is only valid first');
      }
      const members = new Map<string, MemberKind>();
      for (const property of checker.getPropertiesOfType(type)) {
        if (isInternalName(property.name)) continue;
        if (property.name === 'prototype') continue;
        const declaration = property.declarations?.[0];
        const modifiers = declaration ? ts.getCombinedModifierFlags(declaration as ts.Declaration) : 0;
        if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        members.set(property.name, kindOf(property));
      }
      return new Map([...members].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}
