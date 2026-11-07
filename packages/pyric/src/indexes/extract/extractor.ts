/**
 * Top-level extractor — runs the full pipeline (parse → scan → enumerate
 * → composite-detect → dedupe) over a bag of files and produces an
 * `ExtractResult` carrying:
 *
 *   - `config` — ready to write to `firestore.indexes.json` for the
 *     Firebase CLI.
 *   - `signals` — per-collection over-shoot hints the agent layer can
 *     act on (Layer 2: add `@firestore-mutex` annotations).
 *   - `warnings` — per-file diagnostics (partial-base, unknown-callee,
 *     dynamic-arg, dynamic-collection-id, unresolved-query).
 */
import ts from 'typescript';
import { iterFunctionBodies, parseSource } from './ast.js';
import { collectAnnotations } from './annotation-collect.js';
import { scanFunctionBody, scanStandaloneQuery, type CallResolver, type ResolvedCall } from './dataflow.js';
import { getCalleeName } from './ast.js';
import { enumerateShapes, pruneByAnnotations } from './enumerate.js';
import { needsCompositeIndex, shapeToIndexEntry, indexEntryKey } from './composite.js';
import { hasDynamicCollectionId } from './classify.js';
import type {
  AnnotationApplied,
  ExtractOptions,
  ExtractResult,
  ExtractionSignal,
  ExtractionWarning,
  Fragment,
  QueryBaseDecl,
  QueryShape,
} from './types.js';
import type { IndexesConfigEntry } from '../types.js';

/**
 * Heuristic for over-shoot detection: > 3 distinct shapes for one
 * collection is suspicious. Most real apps have 1–3 query patterns
 * per collection — anything higher usually means the cartesian
 * blowup from cross-product over independent optional filters.
 */
const OVERSHOOT_THRESHOLD = 3;

export function extractIndexes(options: ExtractOptions): ExtractResult {
  const queryVarName = options.queryVarName ?? 'q';
  const allShapes: QueryShape[] = [];
  const warnings: ExtractionWarning[] = [];
  const annotationsApplied: AnnotationApplied[] = [];
  /** Tightest budget across all functions that declared one. */
  let tightestBudget: number | undefined;

  for (const file of options.files) {
    let sf: ts.SourceFile;
    try {
      sf = parseSource(file.name, file.source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push({ file: file.name, code: 'parse-error', message });
      continue;
    }

    // Build a name → annotations map for the file. Functions without a
    // leading @firestore-* tag are absent from the map (so the prune
    // step is a true no-op for them).
    const annByFn = new Map<string, ReturnType<typeof collectAnnotations>[number]>();
    for (const collected of collectAnnotations(sf)) {
      if (collected.hasFirestoreTag) annByFn.set(collected.functionName, collected);
      // Surface annotation parser warnings as extractor warnings too,
      // so consumers see them in the unified `warnings` channel.
      for (const w of collected.warnings) {
        warnings.push({
          file: file.name,
          code: 'annotation-malformed',
          message: `Function '${collected.functionName}': ${w.message}`,
        });
      }
    }

    // Layer 2.5: build a same-file resolver so wrapper calls
    // (`q = applyFilters(q, ...)`) inline at the caller's call site.
    const resolver = makeFileResolver(sf);

    // First pass: scan every function body with the resolver. We record
    // the decls so we can use the cumulative `inlinedFunctions` set
    // across all decls to decide whether a wrapper's solo `partial-base`
    // warning should fire.
    interface ScanRecord { fnName: string; decl: QueryBaseDecl }
    const records: ScanRecord[] = [];
    const inlinedAcrossFile = new Set<string>();
    // Every `query(...)` call a chain scan records. The rest are
    // standalone queries, handled after the chains.
    const consumed = new Set<ts.CallExpression>();
    for (const fn of iterFunctionBodies(sf)) {
      const decl = scanFunctionBody(fn.body, queryVarName, resolver, consumed);
      records.push({ fnName: fn.name, decl });
      if (decl.inlinedFunctions) {
        for (const f of decl.inlinedFunctions) inlinedAcrossFile.add(f);
      }
    }

    // Second pass: emit warnings, enumerate shapes, apply annotations.
    for (const { fnName, decl } of records) {
      // Promote inter-proc warnings to the unified channel regardless
      // of whether the function had a base — they're useful diagnostics.
      if (decl.interProcWarnings) {
        for (const w of decl.interProcWarnings) {
          warnings.push({
            file: file.name,
            code: w.code,
            message: `Function '${fnName}': ${w.message}`,
          });
        }
      }

      if (decl.fragments.length === 0 && decl.collectionPath === null) {
        // Function doesn't touch the chain — skip without a warning.
        continue;
      }
      if (decl.collectionPath === null) {
        // Suppress `partial-base` for wrappers that were already inlined
        // into a caller in this file — the caller's INIT covers them.
        if (inlinedAcrossFile.has(fnName)) continue;
        warnings.push({
          file: file.name,
          code: 'partial-base',
          message: `Function '${fnName}' uses '${queryVarName}' but no INIT (\`query(collection(...))\`) found in the same body or any same-file caller — base may live in another module (cross-file following NYI).`,
        });
        continue;
      }
      emitShapes(fnName, decl.collectionPath, decl);
    }

    // Third pass: every `query(...)` call no chain recorded, such as one
    // passed straight into `getDocs` or `onSnapshot`, is a query of its
    // own. One the extractor can't resolve is named by file and line.
    for (const call of standaloneQueryCalls(sf, consumed)) {
      const decl = scanStandaloneQuery(call);
      const fnName = enclosingFunctionName(call);
      if (decl.collectionPath === null) {
        const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
        warnings.push({
          file: file.name,
          line,
          code: 'unresolved-query',
          message: `Function '${fnName}' calls query(...) at line ${line} on something other than collection(db, '<name>') or collectionGroup(db, '<name>') with a literal name, so no index was generated for it.`,
        });
        continue;
      }
      emitShapes(fnName, decl.collectionPath, decl);
    }

    /** Enumerate one query with a resolved base, apply its annotations, and collect its shapes. */
    function emitShapes(fnName: string, collectionPath: string, decl: QueryBaseDecl): void {
      if (hasDynamicCollectionId(collectionPath)) {
        warnings.push({
          file: file.name,
          code: 'dynamic-collection-id',
          message: `Function '${fnName}' queries '${collectionPath}': index for a wildcard collection id skipped: name the collection.`,
        });
        return;
      }
      // Surface any unknown fragments as warnings before enumerating.
      surfaceFragmentWarnings(file.name, fnName, decl.fragments, warnings);
      const enumerated = enumerateShapes(decl);

      // Build the ordered list of annotation sources that apply to this
      // caller: the caller's own annotations first, then each inlined
      // wrapper in source order. Drops are commutative across sources,
      // but ordering matters for deterministic AnnotationApplied output.
      interface AnnotationSource {
        annotations: ReturnType<typeof collectAnnotations>[number]['annotations'];
        warnings: ReturnType<typeof collectAnnotations>[number]['warnings'];
        inlinedFrom?: string;
      }
      const sources: AnnotationSource[] = [];
      const callerAnn = annByFn.get(fnName);
      if (callerAnn) sources.push({ annotations: callerAnn.annotations, warnings: callerAnn.warnings });
      if (decl.inlinedFunctions) {
        for (const wrapperName of decl.inlinedFunctions) {
          const wrapperAnn = annByFn.get(wrapperName);
          if (wrapperAnn) {
            sources.push({
              annotations: wrapperAnn.annotations,
              warnings: wrapperAnn.warnings,
              inlinedFrom: wrapperName,
            });
          }
        }
      }

      if (sources.length === 0) {
        allShapes.push(...enumerated);
      } else {
        // Apply each source's prune to the running shape list. Each source
        // gets its own AnnotationApplied entry attributed to the caller,
        // with `inlinedFrom` set when the annotation came from a wrapper.
        let currentShapes = enumerated;
        for (const src of sources) {
          const pruned = pruneByAnnotations(currentShapes, src.annotations);
          annotationsApplied.push({
            functionName: fnName,
            file: file.name,
            annotations: src.annotations,
            prunedByMutex: pruned.prunedByMutex,
            prunedByRequired: pruned.prunedByRequired,
            warnings: src.warnings,
            ...(src.inlinedFrom ? { inlinedFrom: src.inlinedFrom } : {}),
          });
          if (src.annotations.budget !== undefined) {
            tightestBudget = tightestBudget === undefined
              ? src.annotations.budget
              : Math.min(tightestBudget, src.annotations.budget);
          }
          currentShapes = pruned.shapes;
        }
        allShapes.push(...currentShapes);
      }
    }
  }

  // Composite filter + dedupe by index-entry key.
  const seen = new Set<string>();
  const entries: IndexesConfigEntry[] = [];
  for (const s of allShapes) {
    if (!needsCompositeIndex(s)) continue;
    const entry = shapeToIndexEntry(s);
    const k = indexEntryKey(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push(entry);
  }

  // @firestore-budget — soft cap. Warn but don't drop entries.
  if (tightestBudget !== undefined && entries.length > tightestBudget) {
    warnings.push({
      file: '<config>',
      code: 'budget-exceeded',
      message: `Emitted ${entries.length} composite index entries — exceeds tightest @firestore-budget of ${tightestBudget}. Consider adding more @firestore-mutex groups before deploying.`,
    });
  }

  const signals = buildSignals(allShapes);

  return {
    success: true,
    data: {
      config: { indexes: entries },
      signals,
      warnings,
      shapesEnumerated: allShapes.length,
      annotationsApplied,
    },
  };
}

function surfaceFragmentWarnings(
  file: string,
  fnName: string,
  fragments: Fragment[],
  warnings: ExtractionWarning[],
): void {
  let unknownCount = 0;
  for (const f of fragments) {
    if (f.kind === 'unknown') unknownCount += 1;
  }
  if (unknownCount > 0) {
    warnings.push({
      file,
      code: 'unknown-callee',
      message: `Function '${fnName}' contained ${unknownCount} unrecognized constraint call(s) — these were skipped. Custom helpers wrapping where/orderBy aren't followed in v1.`,
    });
  }
}

/**
 * Every `query(...)` call in `sf` that no chain scan recorded, in source
 * order. A standalone call's own arguments aren't searched, so the inner
 * call of `query(query(...), ...)` is reported with the outer one, not
 * on its own.
 */
function standaloneQueryCalls(sf: ts.SourceFile, consumed: Set<ts.CallExpression>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n) && getCalleeName(n) === 'query' && !consumed.has(n)) {
      calls.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return calls;
}

/**
 * The name annotations are keyed by for the function a call sits in: the
 * nearest enclosing function declaration, method, or function assigned to
 * a variable. An anonymous callback reads through to the function around
 * it. `'<module>'` for a call outside any named function.
 */
function enclosingFunctionName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    const isFunctionValue = ts.isArrowFunction(cur) || ts.isFunctionExpression(cur);
    const declaration = cur.parent;
    if (isFunctionValue && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      return declaration.name.text;
    }
  }
  return '<module>';
}

/**
 * Build a `CallResolver` that knows about every function-like
 * declaration in `sf`. Used by the orchestrator to inline same-file
 * wrappers when the dataflow walker hits `q = wrapper(q, ...)`.
 *
 * Coverage matches `iterFunctionBodies`:
 *   - top-level `function name() {}` declarations
 *   - `const name = (q) => { ... }` arrow expressions
 *   - `const name = function (q) { ... }` function expressions
 *
 * Method declarations and nested function decls are out of scope for
 * v1 (Issue B1 in the layer 2.5 progress doc).
 */
function makeFileResolver(sf: ts.SourceFile): CallResolver {
  // Index function-likes by name once, up front. Cheap; sf is small.
  interface Entry { body: ts.Node; params: ts.NodeArray<ts.ParameterDeclaration> }
  const byName = new Map<string, Entry>();
  function visit(n: ts.Node): void {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      if (!byName.has(n.name.text)) byName.set(n.name.text, { body: n.body, params: n.parameters });
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name)
          && d.initializer
          && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          if (!byName.has(d.name.text)) {
            byName.set(d.name.text, { body: d.initializer.body, params: d.initializer.parameters });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);

  return (functionName, chainArgIndex): ResolvedCall | null => {
    const entry = byName.get(functionName);
    if (!entry) return null;
    const param = entry.params[chainArgIndex];
    if (!param || !ts.isIdentifier(param.name)) return null;
    return { body: entry.body, chainParamName: param.name.text };
  };
}

function buildSignals(shapes: QueryShape[]): ExtractionSignal[] {
  // Group shapes by their derived collectionGroup (last path segment).
  const groups = new Map<string, QueryShape[]>();
  for (const s of shapes) {
    const cg = s.collectionPath.split('/').pop() || s.collectionPath;
    let bucket = groups.get(cg);
    if (!bucket) {
      bucket = [];
      groups.set(cg, bucket);
    }
    bucket.push(s);
  }

  const signals: ExtractionSignal[] = [];
  for (const [collectionGroup, bucket] of groups) {
    const fields = new Set<string>();
    for (const s of bucket) {
      for (const f of s.filters) fields.add(f.field);
      for (const o of s.orders) fields.add(o.field);
    }
    signals.push({
      collectionGroup,
      shapeCount: bucket.length,
      fieldsTouched: Array.from(fields).sort(),
      overshootSuspected: bucket.length > OVERSHOOT_THRESHOLD,
    });
  }
  // Sort for deterministic output.
  signals.sort((a, b) => a.collectionGroup.localeCompare(b.collectionGroup));
  return signals;
}
