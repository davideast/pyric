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
  return sdkBindingSeen(checker, symbol, table, new Set());
}

function sdkBindingSeen(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  table: SdkTable,
  visitedSymbols: Set<ts.Symbol>,
): AVal | undefined {
  let current: ts.Symbol | undefined = symbol;
  for (let hop = 0; current && hop < 32; hop++) {
    if (visitedSymbols.has(current)) return undefined;
    visitedSymbols.add(current);
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
    if (!next || next === current) {
      return reexportBinding(checker, decl, table, visitedSymbols, new Set());
    }
    current = next;
  }
  return undefined;
}

function namespaceExport(spec: string | undefined, table: SdkTable): AVal | undefined {
  let mod: ApiModule | undefined;
  if (spec !== undefined) mod = table.moduleOf(spec);
  if (!mod) return undefined;
  const out: Extract<AVal, { k: 'ns' }> = { k: 'ns', module: mod };
  if (spec !== undefined && table.isAdminModule(spec)) out.admin = true;
  return out;
}

function bindingFromDeclaration(decl: ts.Declaration, table: SdkTable): AVal | undefined {
  if (ts.isImportSpecifier(decl)) {
    const spec = moduleSpecifierText(decl.parent.parent.parent.moduleSpecifier);
    const name = (decl.propertyName ?? decl.name).text;
    return namedExport(spec, name, table);
  }
  if (ts.isNamespaceImport(decl)) {
    const spec = moduleSpecifierText(decl.parent.parent.moduleSpecifier);
    return namespaceExport(spec, table);
  }
  if (ts.isNamespaceExport(decl)) {
    const spec = moduleSpecifierText(decl.parent.moduleSpecifier);
    return namespaceExport(spec, table);
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

function sourceFileFromModuleSpecifier(
  checker: ts.TypeChecker,
  moduleSpecNode: ts.Expression | undefined,
): ts.SourceFile | undefined {
  if (!moduleSpecNode) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecNode);
  const sf = moduleSymbol?.valueDeclaration;
  return sf && ts.isSourceFile(sf) ? sf : undefined;
}

function resolveStarNamespaceFromModule(
  checker: ts.TypeChecker,
  moduleSpecNode: ts.Expression | undefined,
  table: SdkTable,
  visitedFiles: Set<string>,
): AVal | undefined {
  const direct = namespaceExport(moduleSpecifierText(moduleSpecNode), table);
  if (direct) return direct;
  const sf = sourceFileFromModuleSpecifier(checker, moduleSpecNode);
  if (!sf || visitedFiles.has(sf.fileName)) return undefined;
  visitedFiles.add(sf.fileName);
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.exportClause) {
      const found = resolveStarNamespaceFromModule(checker, stmt.moduleSpecifier, table, visitedFiles);
      if (found) return found;
    }
  }
  return undefined;
}

function resolveExportFromModule(
  checker: ts.TypeChecker,
  moduleSpecNode: ts.Expression | undefined,
  exportName: string,
  table: SdkTable,
  visitedSymbols: Set<ts.Symbol>,
  visitedExports: Set<string>,
): AVal | undefined {
  const direct = namedExport(moduleSpecifierText(moduleSpecNode), exportName, table);
  if (direct) return direct;
  const sf = sourceFileFromModuleSpecifier(checker, moduleSpecNode);
  if (!sf) return undefined;
  const visitKey = `${sf.fileName}#${exportName}`;
  if (visitedExports.has(visitKey)) return undefined;
  visitedExports.add(visitKey);

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.exportClause) {
      const found = resolveExportFromModule(
        checker,
        stmt.moduleSpecifier,
        exportName,
        table,
        visitedSymbols,
        visitedExports,
      );
      if (found) return found;
      continue;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      if (stmt.exportClause.name.text === exportName) {
        const found = resolveStarNamespaceFromModule(checker, stmt.moduleSpecifier, table, new Set());
        if (found) return found;
      }
      continue;
    }
    if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text !== exportName) continue;
        if (stmt.moduleSpecifier) {
          const innerName = (el.propertyName ?? el.name).text;
          const found = resolveExportFromModule(
            checker,
            stmt.moduleSpecifier,
            innerName,
            table,
            visitedSymbols,
            visitedExports,
          );
          if (found) return found;
        } else {
          const localSym = checker.getExportSpecifierLocalTargetSymbol(el);
          if (localSym) {
            const found = sdkBindingSeen(checker, localSym, table, visitedSymbols);
            if (found) return found;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve re-exports across single- or multi-hop barrel modules (`export *`,
 * `export * as ns`, and `export { ... }`) whose leaf SDK module is unresolved.
 */
function reexportBinding(
  checker: ts.TypeChecker,
  decl: ts.Declaration,
  table: SdkTable,
  visitedSymbols: Set<ts.Symbol>,
  visitedExports: Set<string>,
): AVal | undefined {
  if (ts.isNamespaceExport(decl)) {
    return resolveStarNamespaceFromModule(checker, decl.parent.moduleSpecifier, table, new Set());
  }
  if (ts.isImportSpecifier(decl)) {
    const moduleSpecNode = decl.parent.parent.parent.moduleSpecifier;
    const name = (decl.propertyName ?? decl.name).text;
    return resolveExportFromModule(checker, moduleSpecNode, name, table, visitedSymbols, visitedExports);
  }
  if (ts.isExportSpecifier(decl)) {
    const moduleSpecNode = decl.parent.parent.moduleSpecifier;
    const name = (decl.propertyName ?? decl.name).text;
    return resolveExportFromModule(checker, moduleSpecNode, name, table, visitedSymbols, visitedExports);
  }
  return undefined;
}
