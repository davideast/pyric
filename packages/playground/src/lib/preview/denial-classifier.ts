/**
 * Static (no LLM, no runtime) classifier for sandbox denials.
 *
 * Signal #1 only for v0 — does the App TSX source *anticipate* the
 * denial? Concretely, two things:
 *
 *   1. Are write ops wrapped in error-handling control flow
 *      (`try/catch` or `.catch()`)?
 *   2. Does the source reference `permission-denied` or
 *      `SandboxError` — i.e., is the catch *actually* meant for rule
 *      denials, not just an incidental network try/catch?
 *
 * Both → `expected`: the app was built to demonstrate this denial.
 * Just (1) → `ambiguous`: a catch is there but we can't tell whether
 *           it was written to handle rule denials or something else.
 * Neither → `unexpected`: bug-shaped, surface the Fix affordance.
 *
 * This is a heuristic. AST-walking with `@babel/parser` would tighten
 * it but adds machinery; the regex pass catches the common cases
 * (try/catch + permission-denied string near the write) and degrades
 * safely. Worst-case false-positive is "mis-framed badge" rather than
 * "denial hidden" — `sandbox.onDenial()` fires regardless of catch,
 * so the row is always surfaced.
 *
 * Future iterations:
 *   - AST: locate the specific write call that issued *this* denial
 *     (by collection / method) and check whether IT specifically is
 *     inside a handling catch — per-op classification, not file-
 *     level.
 *   - Signal #2: user-input-bound field analysis.
 *   - Signal #3: prompt-history NLP / LLM classification.
 */

export type DenialClassification = 'expected' | 'ambiguous' | 'unexpected';

export interface ClassifyResult {
  classification: DenialClassification;
  /** Human-readable single-line reason for the badge. Renders in the
   *  Denials panel under the row title. */
  reason: string;
}

/**
 * Strip JS/TS comments + string literal contents before pattern-
 * matching. Without this a comment like `// no try/catch here` would
 * falsely match `try/catch`, and a string `"permission-denied"`
 * inside an unrelated context (e.g. an error message constant for a
 * different surface) would falsely match `permission-denied`. We
 * keep string *positions* (replaced with spaces) so line/column
 * heuristics still hold if we add them later.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    // Block comment
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    // Line comment
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    // String / template literal — preserve length, drop content
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (ch === quote) {
          out += ch;
          i += 1;
          break;
        }
        out += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Detect any try/catch block in the source. */
function hasTryCatch(stripped: string): boolean {
  return /\btry\s*\{[\s\S]*?\}\s*catch\b/.test(stripped);
}

/** Detect a `.catch(` chained call (promise-style error handling). */
function hasPromiseCatch(stripped: string): boolean {
  return /\.\s*catch\s*\(/.test(stripped);
}

/**
 * Does the source name what a denial actually *is*? We look at the
 * original source (not stripped) because the literal string
 * `'permission-denied'` is the strongest signal — apps that handle
 * denials almost always reference this exact code from the SDK.
 */
function namesDenial(source: string): boolean {
  // SDK error code constant, in any quoting.
  if (/permission[-_]denied/i.test(source)) return true;
  // Our sandbox-flavored error class.
  if (/\bSandboxError\b/.test(source)) return true;
  return false;
}

export function classifyAppDenials(appSource: string): ClassifyResult {
  if (!appSource || appSource.trim().length === 0) {
    return {
      classification: 'unexpected',
      reason: 'No app source to inspect',
    };
  }
  const stripped = stripCommentsAndStrings(appSource);
  const tryCatch = hasTryCatch(stripped);
  const promiseCatch = hasPromiseCatch(stripped);
  const anyCatch = tryCatch || promiseCatch;
  const named = namesDenial(appSource);

  if (anyCatch && named) {
    return {
      classification: 'expected',
      reason: 'App catches denials (try/catch + permission-denied handling)',
    };
  }
  if (anyCatch) {
    return {
      classification: 'ambiguous',
      reason: 'App has error handlers but never references permission-denied',
    };
  }
  return {
    classification: 'unexpected',
    reason: 'No error handling around writes — denial looks unanticipated',
  };
}
