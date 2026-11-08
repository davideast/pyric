/**
 * Recognises SDK imports: which identifiers in the app are modular service
 * APIs (`doc`, `setDoc`, `ref`, `onAuthStateChanged`, ...) or a React hook
 * the evaluator models.
 *
 * Service module specifiers come from registered {@link SdkServiceModel}
 * tables so adding a service requires no changes here.
 */
import ts from 'typescript';
import { FIRESTORE_SERVICE_MODEL } from './service-models/firestore.js';
import { RTDB_SERVICE_MODEL } from './service-models/rtdb.js';
import { STORAGE_SERVICE_MODEL } from './service-models/storage.js';
import type { SdkServiceModel } from './service-models/types.js';
import type { AccessPreset } from './types.js';
import type { ApiModule, AVal } from './values.js';

export const DEFAULT_SERVICE_MODELS: readonly SdkServiceModel[] = [
  FIRESTORE_SERVICE_MODEL,
  RTDB_SERVICE_MODEL,
  STORAGE_SERVICE_MODEL,
];

const NON_SERVICE_MODULES: Readonly<Record<string, ApiModule>> = {
  'firebase/auth': 'auth',
  '@firebase/auth': 'auth',
  'pyric/auth': 'auth',
  react: 'react',
  'react-firebase-hooks/auth': 'auth-hooks',
  'pyric/sandbox/firestore': 'sandbox-firestore',
  'pyric/sandbox/database': 'sandbox-rtdb',
  'pyric/sandbox/storage': 'sandbox-storage',
  '@firebase/rules-unit-testing': 'rules-testing',
};

/** Sentinel export name for a preset function that returns the signed-in user. */
export const AUTH_USER_FUNCTION = '<auth-user>';

/** Module and service-model table built from registered service models plus app presets. */
export class SdkTable {
  private readonly modules = new Map<string, ApiModule>(Object.entries(NON_SERVICE_MODULES));
  private readonly adminModules = new Set<string>();
  private readonly modelsByService = new Map<string, SdkServiceModel>();
  private readonly authUserFns = new Map<string, Set<string>>();
  private readonly writeOps = new Set<string>();

  constructor(presets: AccessPreset[], extraModels: readonly SdkServiceModel[] = []) {
    for (const model of [...DEFAULT_SERVICE_MODELS, ...extraModels]) {
      this.modelsByService.set(model.service, model);
      for (const spec of model.modules) {
        this.modules.set(spec, model.service);
      }
      for (const adminSpec of model.adminModules ?? []) {
        this.adminModules.add(adminSpec);
      }
      for (const op of Object.values(model.operations)) {
        if (op.write) this.writeOps.add(op.op);
      }
      for (const methods of Object.values(model.receiverMethods ?? {})) {
        for (const op of Object.values(methods)) {
          if (op.write) this.writeOps.add(op.op);
        }
      }
      for (const op of Object.values(model.refMethods ?? {})) {
        if (op.write) this.writeOps.add(op.op);
      }
    }
    for (const p of presets) {
      for (const m of p.firestoreModules ?? []) this.modules.set(m, 'firestore');
      for (const m of p.rtdbModules ?? []) this.modules.set(m, 'rtdb');
      for (const m of p.storageModules ?? []) this.modules.set(m, 'storage');
      for (const m of p.authModules ?? []) this.modules.set(m, 'auth');
      for (const spec of p.authUserFunctions ?? []) {
        const [mod, name] = spec.split('#');
        if (!mod || !name) continue;
        const set = this.authUserFns.get(mod) ?? new Set<string>();
        set.add(name);
        this.authUserFns.set(mod, set);
      }
    }
  }

  moduleOf(specifier: string): ApiModule | undefined {
    return this.modules.get(specifier);
  }

  isAdminModule(specifier: string): boolean {
    return this.adminModules.has(specifier);
  }

  serviceModel(module: string): SdkServiceModel | undefined {
    return this.modelsByService.get(module);
  }

  serviceModels(): readonly SdkServiceModel[] {
    return [...this.modelsByService.values()];
  }

  isWriteOp(op: string): boolean {
    return this.writeOps.has(op);
  }

  isAuthUserFunction(specifier: string, name: string): boolean {
    return this.authUserFns.get(specifier)?.has(name) ?? false;
  }
}

function moduleSpecifierText(node: ts.Node | undefined): string | undefined {
  if (node && ts.isStringLiteral(node)) return node.text;
  return undefined;
}

/**
 * If `symbol` is (an alias chain ending in) an SDK import, return its
 * abstract value: `api` for a named export, `ns` for a namespace or
 * default import. Returns undefined for anything else.
 */
export function sdkBinding(checker: ts.TypeChecker, symbol: ts.Symbol, table: SdkTable): AVal | undefined {
  let current: ts.Symbol | undefined = symbol;
  for (let hop = 0; current && hop < 12; hop++) {
    if (!(current.flags & ts.SymbolFlags.Alias)) return undefined;
    const decl = current.declarations?.[0];
    if (!decl) return undefined;
    const found = bindingFromDeclaration(decl, table);
    if (found) return found;
    let next: ts.Symbol | undefined;
    try {
      next = checker.getImmediateAliasedSymbol(current);
    } catch {
      next = undefined;
    }
    if (!next || next === current) return starReexport(checker, decl, table);
    current = next;
  }
  return undefined;
}

function bindingFromDeclaration(decl: ts.Declaration, table: SdkTable): AVal | undefined {
  if (ts.isImportSpecifier(decl)) {
    const spec = moduleSpecifierText(decl.parent.parent.parent.moduleSpecifier);
    const name = (decl.propertyName ?? decl.name).text;
    return namedExport(spec, name, table);
  }
  if (ts.isNamespaceImport(decl)) {
    const spec = moduleSpecifierText(decl.parent.parent.moduleSpecifier);
    let mod: ApiModule | undefined;
    if (spec !== undefined) mod = table.moduleOf(spec);
    if (!mod) return undefined;
    const out: Extract<AVal, { k: 'ns' }> = { k: 'ns', module: mod };
    if (spec !== undefined && table.isAdminModule(spec)) out.admin = true;
    return out;
  }
  if (ts.isImportClause(decl)) {
    // Default import: only React's default export is modelled (`React.useState`).
    const spec = moduleSpecifierText(decl.parent.moduleSpecifier);
    const mod = spec ? table.moduleOf(spec) : undefined;
    return mod === 'react' ? { k: 'ns', module: mod } : undefined;
  }
  if (ts.isExportSpecifier(decl)) {
    const spec = moduleSpecifierText(decl.parent.parent.moduleSpecifier);
    if (spec === undefined) return undefined;
    const name = (decl.propertyName ?? decl.name).text;
    return namedExport(spec, name, table);
  }
  return undefined;
}

function namedExport(spec: string | undefined, name: string, table: SdkTable): AVal | undefined {
  if (spec === undefined) return undefined;
  if (table.isAuthUserFunction(spec, name)) return { k: 'api', module: 'auth-hooks', name: AUTH_USER_FUNCTION };
  const mod = table.moduleOf(spec);
  if (!mod) return undefined;
  const out: Extract<AVal, { k: 'api' }> = { k: 'api', module: mod, name };
  if (table.isAdminModule(spec)) out.admin = true;
  return out;
}

/**
 * `import { doc } from './firebase'` where `./firebase` does
 * `export * from 'firebase/firestore'`: the checker can't see the
 * export (the SDK module is deliberately unresolved), so look for the
 * star re-export in the in-project module.
 */
function starReexport(checker: ts.TypeChecker, decl: ts.Declaration, table: SdkTable): AVal | undefined {
  if (!ts.isImportSpecifier(decl)) return undefined;
  const importDecl = decl.parent.parent.parent;
  const moduleSymbol = checker.getSymbolAtLocation(importDecl.moduleSpecifier);
  const sf = moduleSymbol?.valueDeclaration;
  if (!sf || !ts.isSourceFile(sf)) return undefined;
  const name = (decl.propertyName ?? decl.name).text;
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.exportClause) {
      const found = namedExport(moduleSpecifierText(stmt.moduleSpecifier), name, table);
      if (found) return found;
    }
  }
  return undefined;
}
