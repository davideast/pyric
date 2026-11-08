/**
 * Top-level Firestore composite-index extractor backed by `extractSdkUsage`
 * and `firestoreIndexPass`.
 */
import ts from 'typescript';
import { posixNormalize, toPosixPath } from '../../assurance-surface/code/posix-path.js';
import { FIRESTORE_SERVICE_MODEL } from '../../assurance-surface/code/service-models/firestore.js';
import { extractSdkUsage } from '../../assurance-surface/code/usage-index.js';
import { firestoreIndexPass } from '../../assurance-surface/passes/firestore-indexes.js';
import type { ExtractOptions, ExtractResult, ExtractionWarning } from './types.js';

const VIRTUAL_ROOT = '/__pyric_extract__';
const EXCLUDED_DIR_SEGMENT = /^(?:__tests__|__mocks__|test|tests)$/;
const EXCLUDED_TEST_EXT = /\.(?:test|spec|pw)\.([cm]?[jt]sx?)$/;
const EXCLUDED_MIN_EXT = /\.min\.([cm]?js)$/;
const TSCONFIG_FILE_RE = /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/;

function buildAmbientFirestoreNames(): ReadonlySet<string> {
  const names = new Set<string>([
    ...Object.keys(FIRESTORE_SERVICE_MODEL.handleFactories),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.refConstructors),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.constraints),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.operations),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.receiverFactories ?? {}),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.callbackReceivers ?? {}),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.fieldValues ?? {}),
    ...Object.keys(FIRESTORE_SERVICE_MODEL.specialStrings ?? {}),
    'FieldPath',
  ]);
  if (FIRESTORE_SERVICE_MODEL.queryBuilder) {
    names.add(FIRESTORE_SERVICE_MODEL.queryBuilder);
  }
  return names;
}

const AMBIENT_FIRESTORE_NAMES: ReadonlySet<string> = buildAmbientFirestoreNames();

function sanitizeVirtualSegments(relPath: string): string {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i]!;
    if (EXCLUDED_DIR_SEGMENT.test(seg)) {
      parts[i] = `_pyric_dir_${seg}`;
    }
  }
  const lastIdx = parts.length - 1;
  if (lastIdx >= 0) {
    parts[lastIdx] = parts[lastIdx]!
      .replace(EXCLUDED_TEST_EXT, '._pyric_case.$1')
      .replace(EXCLUDED_MIN_EXT, '._pyric_bundle.$1');
  }
  return parts.join('/');
}

function toVirtualRelPath(rawName: string, index: number): string {
  const posix = toPosixPath(rawName).trim();
  if (!posix) return `file_${index}.ts`;
  const stripped = posix.replace(/^(?:\.\/|\/)+/, '');
  const normalized = posixNormalize(`/${stripped}`).replace(/^\/+/, '');
  return sanitizeVirtualSegments(normalized || `file_${index}.ts`);
}

function collectBindingIdentifiers(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) {
      collectBindingIdentifiers(el.name, out);
    }
  }
}

function collectTopLevelDeclaredNames(sf: ts.SourceFile): Set<string> {
  const declared = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      if (clause.name) declared.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) {
          declared.add(bindings.name.text);
        } else {
          for (const spec of bindings.elements) {
            declared.add(spec.name.text);
          }
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectBindingIdentifiers(decl.name, declared);
      }
    } else if (
      (ts.isFunctionDeclaration(stmt)
        || ts.isClassDeclaration(stmt)
        || ts.isEnumDeclaration(stmt)
        || ts.isInterfaceDeclaration(stmt)
        || ts.isTypeAliasDeclaration(stmt))
      && stmt.name
    ) {
      declared.add(stmt.name.text);
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      declared.add(stmt.name.text);
    }
  }
  return declared;
}

function injectAmbientFirestoreImports(fileName: string, source: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const topDeclared = collectTopLevelDeclaredNames(sf);
  const needed = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && AMBIENT_FIRESTORE_NAMES.has(node.text) && !topDeclared.has(node.text)) {
      needed.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (needed.size === 0) return source;
  const prelude = `import { ${[...needed].sort().join(', ')} } from "firebase/firestore"; `;
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    if (nl < 0) return `${source}\n${prelude}`;
    return `${source.slice(0, nl + 1)}${prelude}${source.slice(nl + 1)}`;
  }
  return `${prelude}${source}`;
}

export function extractIndexes(options: ExtractOptions): ExtractResult {
  if (options.files.length === 0) {
    return {
      success: true,
      data: {
        config: { indexes: [] },
        signals: [],
        warnings: [],
        shapesEnumerated: 0,
        annotationsApplied: [],
      },
    };
  }

  const memoryFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  const displayNames = new Map<string, string>();
  const root = options.root ?? VIRTUAL_ROOT;

  for (const cfg of options.configs ?? []) {
    let cfgKey = cfg.name;
    if (options.root === undefined) {
      cfgKey = toVirtualRelPath(cfg.name, 0);
    }
    memoryFiles[cfgKey] = cfg.source;
  }

  for (let i = 0; i < options.files.length; i += 1) {
    const entry = options.files[i]!;
    let relKey = entry.name;
    if (options.root === undefined) {
      relKey = toVirtualRelPath(entry.name, i);
      if (Object.hasOwn(memoryFiles, relKey)) {
        relKey = `${i}_${relKey}`;
      }
    }
    if (TSCONFIG_FILE_RE.test(relKey)) {
      memoryFiles[relKey] = entry.source;
      continue;
    }
    memoryFiles[relKey] = injectAmbientFirestoreImports(relKey, entry.source);
    displayNames.set(relKey, entry.displayName ?? entry.name);
  }

  const usage = extractSdkUsage({
    root,
    files: memoryFiles,
    clientRoots: options.clientRoots,
    includeReads: true,
  });

  const pass = firestoreIndexPass(usage);
  const warnings: ExtractionWarning[] = pass.warnings.map((w) => {
    const mappedFile = displayNames.get(w.file) ?? w.file;
    const out: ExtractionWarning = {
      file: mappedFile,
      code: w.code,
      message: w.message,
    };
    if (w.line !== undefined) out.line = w.line;
    return out;
  });

  return {
    success: true,
    data: {
      config: pass.config,
      signals: pass.signals,
      warnings,
      shapesEnumerated: pass.shapesEnumerated,
      annotationsApplied: [],
    },
  };
}
