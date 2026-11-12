/**
 * EXPRESSION_LIBRARY_CALLS: the standard library calls a rule spends most on.
 *
 * A function in the linted ruleset counts as a library function when the
 * modules resolver emits the same function for an import of it: same name,
 * parameters, `let` bindings and body. A project function that shares a name
 * but differs in text is not one, so its cost is not attributed to the library.
 * The per-call cost comes from the catalog entry (`stdlib-modules.ts`), which
 * carries the production-measured cost; the call count comes from the
 * estimator's walk (`countRuleFunctionCalls`).
 */
import type { FirestoreRules, FunctionDef } from '../grammar/FirestoreAST.js';
import { parseToAST } from '../grammar/FirestoreParser.js';
import { resolveModulesBrowser } from '../modules/resolver-browser.js';
import { STDLIB_MODULES } from '../stdlib-modules.js';
import { expressionFingerprint } from './ast-utils.js';
import { countRuleFunctionCalls } from './expression-cost.js';

export interface LibraryFunction {
  module: string;
  name: string;
  cost: { min: number; max: number };
  reads: number;
}

export interface RuleLibraryCall extends LibraryFunction {
  /** Calls the rule's condition makes to the function. */
  count: number;
}

export interface RuleLibraryCalls {
  ruleIndex: number;
  matchPath: string;
  blockPath: string;
  line?: number;
  /** Library calls ordered by `cost.max * count`, most expensive first. */
  calls: RuleLibraryCall[];
}

function functionFingerprint(fn: FunctionDef): string {
  return JSON.stringify([
    fn.parameters,
    fn.lets.map((b) => [b.name, expressionFingerprint(b.value)]),
    expressionFingerprint(fn.body),
  ]);
}

let catalog: Map<string, LibraryFunction & { fingerprint: string }> | null = null;

/** Library functions by name, as the modules resolver emits them. */
function libraryCatalog(): Map<string, LibraryFunction & { fingerprint: string }> {
  if (catalog) return catalog;
  const out = new Map<string, LibraryFunction & { fingerprint: string }>();
  for (const module of STDLIB_MODULES) {
    if (module.kind !== 'user-module') continue;
    const names = module.entries.map((e) => e.signature.slice(0, e.signature.indexOf('(')));
    const service = module.services.includes('firestore')
      ? 'service cloud.firestore { match /databases/{database}/documents { } }'
      : 'service firebase.storage { match /b/{bucket}/o { } }';
    const resolved = resolveModulesBrowser(
      `rules_version = '2+modules';\nimport { ${names.join(', ')} } from '${module.key}';\n${service}\n`,
    );
    if (!resolved.success) continue;
    const ast = parseToAST(resolved.data.resolved);
    if (!ast) continue;
    const fns = new Map<string, FunctionDef>();
    for (const fn of [...(ast.functions ?? []), ...(ast.service.functions ?? [])]) fns.set(fn.name, fn);
    for (const entry of module.entries) {
      const name = entry.signature.slice(0, entry.signature.indexOf('('));
      const fn = fns.get(name);
      if (!fn || !entry.cost) continue;
      out.set(name, {
        module: module.key,
        name,
        cost: entry.cost,
        reads: entry.reads ?? 0,
        fingerprint: functionFingerprint(fn),
      });
    }
  }
  catalog = out;
  return out;
}

/** The library function `fn` is, or null when it is a project function. */
export function libraryFunctionFor(fn: FunctionDef): LibraryFunction | null {
  const hit = libraryCatalog().get(fn.name);
  if (!hit || hit.fingerprint !== functionFingerprint(fn)) return null;
  const { fingerprint: _, ...rest } = hit;
  return rest;
}

/** Library calls of every allow rule that makes at least one. */
export function ruleLibraryCalls(ast: FirestoreRules): RuleLibraryCalls[] {
  const out: RuleLibraryCalls[] = [];
  for (const rule of countRuleFunctionCalls(ast)) {
    const calls: RuleLibraryCall[] = [];
    for (const { fn, count } of rule.calls) {
      const lib = libraryFunctionFor(fn);
      if (lib) calls.push({ ...lib, count });
    }
    if (calls.length === 0) continue;
    calls.sort((a, b) => b.cost.max * b.count - a.cost.max * a.count || a.name.localeCompare(b.name));
    out.push({
      ruleIndex: rule.ruleIndex,
      matchPath: rule.matchPath,
      blockPath: rule.blockPath,
      ...(rule.line !== undefined ? { line: rule.line } : {}),
      calls,
    });
  }
  return out;
}
