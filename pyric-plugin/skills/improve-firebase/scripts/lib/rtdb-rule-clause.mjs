import { firstDefined, isReadOperationMethod } from './contracts.mjs';
import {
  formatRuleExpressionSummary,
  parseJsonWithComments,
  tryNormalizeServiceName,
} from './op-snippet.mjs';

function isWriteMethod(method = 'set') {
  return !isReadOperationMethod(method);
}

function normalizeRuleClauseExpr(expr) {
  return String(expr ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCleanSegments(rawPath) {
  return String(rawPath || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

function stepRtdbRuleCursor(cursor, seg) {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(cursor, seg) && !seg.startsWith('.')) {
    return { key: seg, next: cursor[seg] };
  }
  const wildcard = Object.keys(cursor).find((k) => k.startsWith('$'));
  if (wildcard) {
    return { key: wildcard, next: cursor[wildcard] };
  }
  return null;
}

function collectRtdbClauseChain(root, segments, prop) {
  const chain = [];
  let cursor = root;
  let pathLabel = '';
  let matchedAll = true;

  if (typeof cursor[prop] === 'string' || typeof cursor[prop] === 'boolean') {
    chain.push({
      depth: 0,
      scope: '/',
      expr: normalizeRuleClauseExpr(cursor[prop]),
      rawExpr: String(cursor[prop]),
    });
  }

  for (let i = 0; i < segments.length; i += 1) {
    const stepped = stepRtdbRuleCursor(cursor, segments[i]);
    if (!stepped) {
      matchedAll = false;
      break;
    }
    cursor = stepped.next;
    pathLabel = pathLabel ? `${pathLabel}/${stepped.key}` : stepped.key;
    if (
      cursor &&
      typeof cursor === 'object' &&
      !Array.isArray(cursor) &&
      (typeof cursor[prop] === 'string' || typeof cursor[prop] === 'boolean')
    ) {
      chain.push({
        depth: i + 1,
        scope: pathLabel,
        expr: normalizeRuleClauseExpr(cursor[prop]),
        rawExpr: String(cursor[prop]),
      });
    }
  }

  return {
    chain,
    deepestScope: pathLabel || '/',
    reachedNode: matchedAll ? cursor : null,
  };
}

function areClauseChainsEqual(chainA, chainB) {
  if (chainA.length !== chainB.length) return false;
  for (let i = 0; i < chainA.length; i += 1) {
    if (chainA[i].depth !== chainB[i].depth || chainA[i].expr !== chainB[i].expr) {
      return false;
    }
  }
  return true;
}

function findDeepestChangedScope(beforeChain, afterChain) {
  const beforeByDepth = new Map(beforeChain.map((item) => [item.depth, item]));
  const afterByDepth = new Map(afterChain.map((item) => [item.depth, item]));
  const allDepths = Array.from(new Set([...beforeByDepth.keys(), ...afterByDepth.keys()])).sort(
    (a, b) => b - a,
  );
  for (const depth of allDepths) {
    const bItem = beforeByDepth.get(depth);
    const aItem = afterByDepth.get(depth);
    if (!bItem || !aItem || bItem.expr !== aItem.expr) {
      return aItem?.scope || bItem?.scope || null;
    }
  }
  return null;
}

function collectWrittenRelativePaths(payload, maxDepth = 4) {
  const out = [];
  const seen = new Set();

  function recordSegs(segs) {
    if (segs.length === 0 || segs.length > maxDepth) return;
    const key = segs.join('/');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(segs);
    }
  }

  function visit(val, prefixSegs) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return;
    if (prefixSegs.length >= maxDepth) return;
    for (const [rawKey, childVal] of Object.entries(val)) {
      const keyParts = String(rawKey)
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
      if (keyParts.length === 0) continue;
      const acc = [...prefixSegs];
      for (const part of keyParts) {
        acc.push(part);
        recordSegs([...acc]);
      }
      if (acc.length < maxDepth && childVal && typeof childVal === 'object' && !Array.isArray(childVal)) {
        visit(childVal, acc);
      }
    }
  }

  visit(payload, []);
  return out;
}

function collectSubtreeRuleRelativePaths(node, maxDepth = 4) {
  const out = [];
  const seen = new Set();

  function visit(curr, prefixSegs) {
    if (!curr || typeof curr !== 'object' || Array.isArray(curr)) return;
    if (prefixSegs.length >= maxDepth) return;
    for (const [key, val] of Object.entries(curr)) {
      if (key.startsWith('.')) continue;
      const nextSegs = [...prefixSegs, key];
      const joined = nextSegs.join('/');
      if (!seen.has(joined)) {
        seen.add(joined);
        out.push(nextSegs);
      }
      visit(val, nextSegs);
    }
  }

  visit(node, []);
  return out;
}

function parseRtdbRulesRoot(rulesInput) {
  if (rulesInput === null || rulesInput === undefined) return null;
  if (typeof rulesInput === 'object' && !Array.isArray(rulesInput)) {
    if (rulesInput.rules && typeof rulesInput.rules === 'object' && !Array.isArray(rulesInput.rules)) {
      return rulesInput.rules;
    }
    if ('rtdb' in rulesInput || 'firestore' in rulesInput || 'before' in rulesInput || 'after' in rulesInput) {
      return null;
    }
    return rulesInput;
  }
  if (typeof rulesInput !== 'string') return null;
  const trimmed = rulesInput.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
    return null;
  }
  try {
    const parsed = parseJsonWithComments(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.rules && typeof parsed.rules === 'object' && !Array.isArray(parsed.rules)) {
      return parsed.rules;
    }
    return parsed;
  } catch {
    return null;
  }
}

function snippetMentionsRtdbClause(value, clause) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || parseRtdbRulesRoot(trimmed) !== null) return false;
  if (clause === '.validate') {
    return /"\.validate"\s*:|(?:^|[\s:])\.validate\s*:/.test(trimmed);
  }
  if (clause === '.write') {
    return /"\.write"\s*:|(?:^|[\s:])\.write\s*:/.test(trimmed);
  }
  return false;
}

function extractScopeFromSnippet(value) {
  if (typeof value !== 'string') return null;
  const m = /^([A-Za-z0-9_$/.-]+)\s*:\s*"(?:\.write|\.read|\.validate)"\s*:/.exec(value.trim());
  if (!m) return null;
  return m[1].trim().replace(/^\/+|\/+$/g, '') || null;
}

/**
 * Accepts inline rule objects, JSON/JSONC rule text, CEL `.rules` source, or focused rule snippets,
 * while returning `null` for unresolved file-path strings so missing paths never leak into slides.
 */
export function sanitizeInlineRuleSource(ruleRef) {
  if (ruleRef === null || ruleRef === undefined) return null;
  if (typeof ruleRef === 'object' && !Array.isArray(ruleRef)) return ruleRef;
  if (typeof ruleRef !== 'string') return null;
  const trimmed = ruleRef.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.includes('\n')
  ) {
    return trimmed;
  }
  if (
    /^(?:rules_version\b|service\s+(?:cloud\.firestore|firebase\.storage)\b|match\s+\/|allow\s+)/.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  if (
    /["']?\.(?:read|write|validate)["']?\s*:/.test(trimmed) ||
    /\b(?:auth|newData|data|request\.auth|resource)\b/.test(trimmed) ||
    trimmed === 'true' ||
    trimmed === 'false'
  ) {
    return trimmed;
  }
  return null;
}

/**
 * Formats an RTDB rule scope concisely while walking back past any leading `$` wildcards
 * so multi-wildcard paths keep their nearest literal collection segment.
 */
export function formatShortRtdbScope(scope) {
  if (!scope || scope === '/') return '';
  const parts = String(scope).split('/').filter(Boolean);
  if (parts.length <= 2) {
    return parts.join('/');
  }
  let startIdx = parts.length - 2;
  while (startIdx > 0 && parts[startIdx].startsWith('$')) {
    startIdx -= 1;
  }
  return parts.slice(startIdx).join('/');
}

function formatRtdbRuleSnippet(scope, ruleProp, rawExpr, maxLen) {
  const shortScope = formatShortRtdbScope(scope);
  const maxRuleLen = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 136;
  let exprText = rawExpr;
  if (rawExpr !== 'true' && rawExpr !== 'false') {
    let body = rawExpr;
    if (rawExpr.length > maxRuleLen) {
      body = formatRuleExpressionSummary(rawExpr, maxRuleLen);
    }
    exprText = `"${body}"`;
  }
  if (shortScope) {
    return `${shortScope}: "${ruleProp}": ${exprText}`;
  }
  return `"${ruleProp}": ${exprText}`;
}

/**
 * Extracts a concise single-line RTDB rule snippet focused on `targetPath` or
 * `options.fallbackScope` (which takes precedence for multi-level `.validate` diffs).
 */
export function extractFocusedRtdbRule(parsed, targetPath, method, maxLen = 136, options = {}) {
  const root =
    parsed && typeof parsed.rules === 'object' && parsed.rules !== null ? parsed.rules : parsed;
  if (!root || typeof root !== 'object') return null;

  let ruleProp = isWriteMethod(method) ? '.write' : '.read';
  if (
    options?.ruleProp === '.read' ||
    options?.ruleProp === '.write' ||
    options?.ruleProp === '.validate'
  ) {
    ruleProp = options.ruleProp;
  }

  const segments = splitCleanSegments(targetPath);

  if (
    ruleProp === '.validate' &&
    typeof options?.fallbackScope === 'string' &&
    options.fallbackScope.trim().length > 0
  ) {
    const fallbackSegs = splitCleanSegments(options.fallbackScope);
    const normalizedFallbackScope = fallbackSegs.length > 0 ? fallbackSegs.join('/') : '/';
    const secondary = collectRtdbClauseChain(root, fallbackSegs, '.validate');
    const exactSecondary = secondary.chain.find(
      (entry) => entry.scope === normalizedFallbackScope,
    );
    if (exactSecondary) {
      return formatRtdbRuleSnippet(exactSecondary.scope, '.validate', exactSecondary.rawExpr, maxLen);
    }
    if (fallbackSegs.length > 0) {
      const primaryForSuffix = collectRtdbClauseChain(root, segments, '.validate');
      const suffixMatch = primaryForSuffix.chain.find(
        (entry) =>
          entry.scope === normalizedFallbackScope ||
          entry.scope.endsWith(`/${normalizedFallbackScope}`),
      );
      if (suffixMatch) {
        return formatRtdbRuleSnippet(suffixMatch.scope, '.validate', suffixMatch.rawExpr, maxLen);
      }
    }
    return formatRtdbRuleSnippet(normalizedFallbackScope, '.validate', 'true', maxLen);
  }

  const primary = collectRtdbClauseChain(root, segments, ruleProp);
  if (primary.chain.length > 0) {
    const deepest = primary.chain[primary.chain.length - 1];
    return formatRtdbRuleSnippet(deepest.scope, ruleProp, deepest.rawExpr, maxLen);
  }

  if (ruleProp === '.validate') {
    const missingScope = primary.deepestScope || '/';
    return formatRtdbRuleSnippet(missingScope, '.validate', 'true', maxLen);
  }

  return null;
}

/**
 * Resolves the governing RTDB rule clause (`.read`, `.write`, or `.validate`)
 * for stage rendering and rule-snippet extraction.
 */
export function resolveRtdbRuleClause({
  operation = {},
  service: rawServiceArg,
  method: rawMethodArg,
  path: rawPathArg,
  data: rawDataArg,
  beforeRules = null,
  afterRules = null,
  fixRules = null,
  explicitClause = null,
} = {}) {
  const method = rawMethodArg ?? operation?.method ?? 'set';
  if (isReadOperationMethod(method)) {
    return { clause: '.read', changedScope: null };
  }

  const rawService = rawServiceArg ?? operation?.service ?? 'database';
  const normalizedService = tryNormalizeServiceName(rawService, 'database').toLowerCase();
  if (normalizedService !== 'database') {
    return { clause: '.write', changedScope: null };
  }

  if (explicitClause === '.validate' || explicitClause === '.write') {
    return { clause: explicitClause, changedScope: null };
  }

  const directSnippets = [fixRules?.before, fixRules?.after].filter((v) => typeof v === 'string');
  if (directSnippets.length > 0) {
    const mentionsValidate = directSnippets.some((s) => snippetMentionsRtdbClause(s, '.validate'));
    const mentionsWrite = directSnippets.some((s) => snippetMentionsRtdbClause(s, '.write'));
    if (mentionsValidate && !mentionsWrite) {
      const scope =
        extractScopeFromSnippet(fixRules?.after) || extractScopeFromSnippet(fixRules?.before);
      return { clause: '.validate', changedScope: scope };
    }
    if (mentionsWrite && !mentionsValidate) {
      return { clause: '.write', changedScope: null };
    }
  }

  const beforeRoot = parseRtdbRulesRoot(beforeRules);
  const afterRoot = parseRtdbRulesRoot(afterRules);
  if (beforeRoot && afterRoot) {
    const targetPath = rawPathArg ?? operation?.path ?? '/';
    const segments = splitCleanSegments(targetPath);

    const beforeWrite = collectRtdbClauseChain(beforeRoot, segments, '.write');
    const afterWrite = collectRtdbClauseChain(afterRoot, segments, '.write');
    if (!areClauseChainsEqual(beforeWrite.chain, afterWrite.chain)) {
      return { clause: '.write', changedScope: null };
    }

    const beforeValidate = collectRtdbClauseChain(beforeRoot, segments, '.validate');
    const afterValidate = collectRtdbClauseChain(afterRoot, segments, '.validate');
    if (!areClauseChainsEqual(beforeValidate.chain, afterValidate.chain)) {
      return {
        clause: '.validate',
        changedScope: findDeepestChangedScope(beforeValidate.chain, afterValidate.chain),
      };
    }

    let payload = rawDataArg;
    if (payload === undefined) {
      payload = firstDefined(operation?.data, operation?.values, operation?.value);
    }
    let candidateRelPaths = collectWrittenRelativePaths(payload);
    if (candidateRelPaths.length === 0) {
      const beforeSubPaths = collectSubtreeRuleRelativePaths(beforeValidate.reachedNode);
      const afterSubPaths = collectSubtreeRuleRelativePaths(afterValidate.reachedNode);
      const seenRel = new Set();
      candidateRelPaths = [];
      for (const rel of [...afterSubPaths, ...beforeSubPaths]) {
        const key = rel.join('/');
        if (!seenRel.has(key)) {
          seenRel.add(key);
          candidateRelPaths.push(rel);
        }
      }
    }

    let childChangedScope = null;
    let childChangedDepth = -1;
    for (const rel of candidateRelPaths) {
      const subSegments = segments.concat(rel);
      const subBeforeWrite = collectRtdbClauseChain(beforeRoot, subSegments, '.write');
      const subAfterWrite = collectRtdbClauseChain(afterRoot, subSegments, '.write');
      if (!areClauseChainsEqual(subBeforeWrite.chain, subAfterWrite.chain)) {
        return { clause: '.write', changedScope: null };
      }
      const subBeforeValidate = collectRtdbClauseChain(beforeRoot, subSegments, '.validate');
      const subAfterValidate = collectRtdbClauseChain(afterRoot, subSegments, '.validate');
      if (!areClauseChainsEqual(subBeforeValidate.chain, subAfterValidate.chain)) {
        const candidateScope = findDeepestChangedScope(
          subBeforeValidate.chain,
          subAfterValidate.chain,
        );
        const candidateDepth = candidateScope ? splitCleanSegments(candidateScope).length : 0;
        if (candidateScope && candidateDepth > childChangedDepth) {
          childChangedScope = candidateScope;
          childChangedDepth = candidateDepth;
        }
      }
    }
    if (childChangedScope) {
      return { clause: '.validate', changedScope: childChangedScope };
    }

    return { clause: '.write', changedScope: null };
  }

  const fallbackSnippets = [
    beforeRules,
    afterRules,
    fixRules?.beforeFull,
    fixRules?.afterFull,
    fixRules?.matchedRule,
    fixRules?.rule,
  ].filter((v) => typeof v === 'string');
  if (fallbackSnippets.length > 0) {
    const mentionsValidate = fallbackSnippets.some((s) => snippetMentionsRtdbClause(s, '.validate'));
    const mentionsWrite = fallbackSnippets.some((s) => snippetMentionsRtdbClause(s, '.write'));
    if (mentionsValidate && !mentionsWrite) {
      const scope =
        extractScopeFromSnippet(fixRules?.afterFull) ||
        extractScopeFromSnippet(afterRules) ||
        extractScopeFromSnippet(fixRules?.beforeFull) ||
        extractScopeFromSnippet(beforeRules);
      return { clause: '.validate', changedScope: scope };
    }
  }

  return { clause: '.write', changedScope: null };
}
