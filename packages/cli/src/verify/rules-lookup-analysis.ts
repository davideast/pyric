import {
  parseToASTOrError,
  resolveModulesBrowser,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
} from 'pyric/rules/internal';

const DOCUMENT_LOOKUP_NAMES = new Set(['get', 'exists', 'getAfter', 'existsAfter']);

function isLookupIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isLookupIdentPart(ch: string): boolean {
  return isLookupIdentStart(ch) || (ch.charCodeAt(0) >= 48 && ch.charCodeAt(0) <= 57);
}

function nextNonTriviaChar(source: string, start: number): string | undefined {
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return ch;
  }
  return undefined;
}

type LookupScanToken =
  | { kind: 'ident'; value: string }
  | { kind: 'dot' }
  | { kind: 'other' };

export function textContainsDocumentLookupCall(source: string): boolean {
  let prev3: LookupScanToken | undefined;
  let prev2: LookupScanToken | undefined;
  let prev1: LookupScanToken | undefined;
  const pushToken = (tok: LookupScanToken): void => {
    prev3 = prev2;
    prev2 = prev1;
    prev1 = tok;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 2;
        else i++;
      }
      if (i < source.length) i++;
      pushToken({ kind: 'other' });
      continue;
    }
    if (isLookupIdentStart(ch)) {
      const start = i;
      i++;
      while (i < source.length && isLookupIdentPart(source[i]!)) i++;
      const word = source.slice(start, i);
      if (
        word === 'import' &&
        prev1?.kind !== 'dot' &&
        !(prev1?.kind === 'ident' && prev1.value === 'function')
      ) {
        return true;
      }
      if (DOCUMENT_LOOKUP_NAMES.has(word) && nextNonTriviaChar(source, i) === '(') {
        const isFnDecl = prev1?.kind === 'ident' && prev1.value === 'function';
        if (!isFnDecl) {
          if (prev1?.kind !== 'dot') {
            return true;
          }
          const isTopLevelFirestoreReceiver =
            prev2?.kind === 'ident' &&
            prev2.value === 'firestore' &&
            prev3?.kind !== 'dot' &&
            !(prev3?.kind === 'ident' && prev3.value === 'function');
          if (isTopLevelFirestoreReceiver) {
            return true;
          }
        }
      }
      pushToken({ kind: 'ident', value: word });
      continue;
    }
    if (ch === '.') {
      pushToken({ kind: 'dot' });
      i++;
      continue;
    }
    pushToken({ kind: 'other' });
    i++;
  }
  return false;
}

function expressionUsesDocumentLookup(
  expr: Expression,
  shadowedLocals: ReadonlySet<string>,
): boolean {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return false;
    case 'functionCall':
      if (DOCUMENT_LOOKUP_NAMES.has(expr.name)) return true;
      return expr.args.some((arg) => expressionUsesDocumentLookup(arg, shadowedLocals));
    case 'methodCall':
      if (
        DOCUMENT_LOOKUP_NAMES.has(expr.method) &&
        expr.object.type === 'identifier' &&
        expr.object.name === 'firestore' &&
        !shadowedLocals.has('firestore')
      ) {
        return true;
      }
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expr.args.some((arg) => expressionUsesDocumentLookup(arg, shadowedLocals))
      );
    case 'memberAccess':
      return expressionUsesDocumentLookup(expr.object, shadowedLocals);
    case 'bracketAccess':
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.index, shadowedLocals)
      );
    case 'sliceAccess':
      return (
        expressionUsesDocumentLookup(expr.object, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.start, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.end, shadowedLocals)
      );
    case 'binaryOp':
      return (
        expressionUsesDocumentLookup(expr.left, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.right, shadowedLocals)
      );
    case 'unaryOp':
      return expressionUsesDocumentLookup(expr.operand, shadowedLocals);
    case 'ternary':
      return (
        expressionUsesDocumentLookup(expr.condition, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.consequent, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.alternate, shadowedLocals)
      );
    case 'inExpr':
      return (
        expressionUsesDocumentLookup(expr.element, shadowedLocals) ||
        expressionUsesDocumentLookup(expr.collection, shadowedLocals)
      );
    case 'isExpr':
      return expressionUsesDocumentLookup(expr.value, shadowedLocals);
    case 'listLiteral':
      return expr.elements.some((el) => expressionUsesDocumentLookup(el, shadowedLocals));
    case 'mapLiteral':
      return expr.entries.some(
        (entry) =>
          expressionUsesDocumentLookup(entry.key, shadowedLocals) ||
          expressionUsesDocumentLookup(entry.value, shadowedLocals),
      );
    case 'pathLiteral':
      return expr.segments.some(
        (seg) => typeof seg !== 'string' && expressionUsesDocumentLookup(seg, shadowedLocals),
      );
  }
}

function functionDefUsesDocumentLookup(
  fn: FunctionDef,
  parentLocals: ReadonlySet<string>,
): boolean {
  const locals = new Set(parentLocals);
  for (const param of fn.parameters) locals.add(param);
  for (const binding of fn.lets) {
    if (expressionUsesDocumentLookup(binding.value, locals)) return true;
    locals.add(binding.name);
  }
  return expressionUsesDocumentLookup(fn.body, locals);
}

function matchBlockUsesDocumentLookup(
  block: MatchBlock,
  locals: ReadonlySet<string>,
): boolean {
  if (block.functions.some((fn) => functionDefUsesDocumentLookup(fn, locals))) return true;
  if (block.allows.some((allow) => expressionUsesDocumentLookup(allow.condition, locals))) {
    return true;
  }
  return block.children.some((child) => matchBlockUsesDocumentLookup(child, locals));
}

function astUsesDocumentLookups(ast: FirestoreRules): boolean {
  const emptyLocals = new Set<string>();
  if ((ast.functions ?? []).some((fn) => functionDefUsesDocumentLookup(fn, emptyLocals))) {
    return true;
  }
  const services = ast.services ?? (ast.service ? [ast.service] : []);
  for (const svc of services) {
    if ((svc.functions ?? []).some((fn) => functionDefUsesDocumentLookup(fn, emptyLocals))) {
      return true;
    }
    const matches = svc.matches ?? (svc.match ? [svc.match] : []);
    if (matches.some((m) => matchBlockUsesDocumentLookup(m, emptyLocals))) {
      return true;
    }
  }
  return false;
}

export function rulesSourceUsesLookups(source: string | undefined): boolean {
  if (typeof source !== 'string' || source.trim().length === 0) return false;
  const parsedInitial = parseToASTOrError(source);
  if (parsedInitial.ok) {
    if (parsedInitial.ast.imports.length > 0) {
      const resolved = resolveModulesBrowser(source, { targetService: 'cloud.firestore' });
      if (!resolved.success) return true;
      const parsedResolved = parseToASTOrError(resolved.data.resolved);
      if (!parsedResolved.ok) return true;
      return astUsesDocumentLookups(parsedResolved.ast);
    }
    return astUsesDocumentLookups(parsedInitial.ast);
  }
  return textContainsDocumentLookupCall(source);
}
