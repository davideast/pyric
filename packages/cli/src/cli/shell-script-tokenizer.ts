/**
 * Lexical tokenization, operator expansion, command-substitution extraction,
 * and GNU `env -S` splitting for POSIX shell and launcher command strings.
 */

/** Tokens that end one command and begin the next inside a shell string. */
export const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

/** Grouping tokens that leave the parser at the start of a command. */
export const COMMAND_GROUP_TOKENS = new Set(['(', ')', '{', '}']);

/** Leading `KEY=VAL` environment assignments in a shell command. */
export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface ShellToken {
  readonly value: string;
  readonly hasDynamicExpansion: boolean;
  readonly hasUnquotedGlob: boolean;
  readonly isQuoted: boolean;
}

export type FlatScriptTokens =
  | { readonly kind: 'classified'; readonly tokens: readonly ShellToken[] }
  | { readonly kind: 'unclassified' };

function plainToken(value: string): ShellToken {
  return { value, hasDynamicExpansion: false, hasUnquotedGlob: false, isQuoted: false };
}

/**
 * Split unquoted shell operators and subshell parentheses inside a single
 * whitespace-free CLI argv token (e.g. `b;`, `false||deno`, `(bun`), while
 * leaving multi-word arguments, `KEY=VAL` assignments, `--flag=val` options,
 * and URLs intact.
 */
export function expandUnquotedOperators(token: string): ShellToken[] {
  if (
    token.length === 0 ||
    SHELL_OPERATORS.has(token) ||
    COMMAND_GROUP_TOKENS.has(token) ||
    /\s/.test(token) ||
    ENV_ASSIGNMENT.test(token) ||
    /^--[A-Za-z0-9_-]+=/.test(token) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)
  ) {
    return [plainToken(token)];
  }

  const out: ShellToken[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(plainToken(buf));
      buf = '';
    }
  };

  while (i < token.length) {
    const ch = token[i]!;
    const two = token.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      out.push(plainToken(two));
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      out.push(plainToken(ch));
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function isDollarExpansionNext(next: string | undefined): boolean {
  return next !== undefined && /[A-Za-z_0-9{?*@#$\-!]/.test(next);
}

/**
 * Tokenize a shell `-c` script into words and unquoted operators for early
 * static scanning (best-effort across arbitrary shell syntax).
 */
export function tokenizeShellScript(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let inToken = false;
  let hasDynamicExpansion = false;
  let hasUnquotedGlob = false;
  let isQuoted = false;
  let i = 0;

  const flush = (): void => {
    if (inToken) {
      tokens.push({ value: current, hasDynamicExpansion, hasUnquotedGlob, isQuoted });
      current = '';
      inToken = false;
      hasDynamicExpansion = false;
      hasUnquotedGlob = false;
      isQuoted = false;
    }
  };

  while (i < script.length) {
    const ch = script[i]!;
    const two = script.slice(i, i + 2);
    if (ch === '\n' || ch === '\r') {
      flush();
      tokens.push(plainToken(';'));
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    if (two === ';;' || two === '&&' || two === '||') {
      flush();
      tokens.push(plainToken(two === ';;' ? ';' : two));
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      tokens.push(plainToken(ch));
      i++;
      continue;
    }
    inToken = true;
    if (ch === "'") {
      isQuoted = true;
      i++;
      while (i < script.length && script[i] !== "'") {
        current += script[i]!;
        i++;
      }
      if (i < script.length) i++;
      continue;
    }
    if (ch === '"') {
      isQuoted = true;
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length && (script[i + 1] === '"' || script[i + 1] === '\\')) {
          current += script[i + 1]!;
          i += 2;
          continue;
        }
        if (script[i] === '$' && isDollarExpansionNext(script[i + 1])) {
          hasDynamicExpansion = true;
        }
        current += script[i]!;
        i++;
      }
      if (i < script.length) i++;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      current += script[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '$' && isDollarExpansionNext(script[i + 1])) {
      hasDynamicExpansion = true;
    }
    if (ch === '*' || ch === '?' || ch === '[') {
      hasUnquotedGlob = true;
    }
    current += ch;
    i++;
  }
  flush();
  return tokens;
}

/**
 * Tokenize a flat POSIX shell script for `spawnSandboxChild` rewriting; returns
 * `'unclassified'` when the script contains command substitutions, ANSI-C
 * quotes, heredocs, or unclosed quotes so the caller leaves the raw script
 * intact for execution-time `PATH` shim enforcement.
 */
export function tokenizeFlatShellScript(script: string): FlatScriptTokens {
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const two = script.slice(i, i + 2);
    if (ch === "'") {
      i++;
      while (i < script.length && script[i] !== "'") i++;
      if (i >= script.length) return { kind: 'unclassified' };
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= script.length) return { kind: 'unclassified' };
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '`' || script[i] === '$') {
          return { kind: 'unclassified' };
        }
        if (script[i] === '\\') {
          if (i + 1 >= script.length) return { kind: 'unclassified' };
          i++;
        }
        i++;
      }
      if (i >= script.length) return { kind: 'unclassified' };
      continue;
    }
    if (
      ch === '$' ||
      ch === '`' ||
      ch === '*' ||
      ch === '?' ||
      ch === '[' ||
      two === '<(' ||
      two === '>(' ||
      two === '<<'
    ) {
      return { kind: 'unclassified' };
    }
  }
  return { kind: 'classified', tokens: tokenizeShellScript(script) };
}

/**
 * Extract POSIX `$(...)` (including `$((cmd); ...)` subshells) and backtick
 * `` `...` `` command-substitution bodies from unquoted and double-quoted
 * segments, tracking `case ... esac` pattern `)` delimiters.
 */
export function extractCommandSubstitutions(script: string): string[] {
  const bodies: string[] = [];
  let inDoubleQuote = false;
  let i = 0;

  while (i < script.length) {
    const ch = script[i]!;
    if (!inDoubleQuote && ch === "'") {
      i++;
      while (i < script.length && script[i] !== "'") i++;
      if (i < script.length) i++;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      i += 2;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }
    if (ch === '$' && script[i + 1] === '(') {
      let depth = 1;
      let caseDepth = 0;
      let casePatternParen = 0;
      let word = '';
      let j = i + 2;
      let subSingle = false;
      let subDouble = false;

      const flushWord = (): void => {
        if (word === 'case') caseDepth += 1;
        else if (word === 'esac' && caseDepth > 0) caseDepth -= 1;
        word = '';
      };

      while (j < script.length && depth > 0) {
        const c = script[j]!;
        if (!subDouble && c === "'") {
          flushWord();
          subSingle = !subSingle;
          j++;
          continue;
        }
        if (!subSingle && c === '\\' && j + 1 < script.length) {
          flushWord();
          j += 2;
          continue;
        }
        if (!subSingle && c === '"') {
          flushWord();
          subDouble = !subDouble;
          j++;
          continue;
        }
        if (!subSingle && !subDouble) {
          if (/[A-Za-z0-9_]/.test(c)) {
            word += c;
            j++;
            continue;
          }
          flushWord();
          if (c === '(') {
            if (caseDepth > 0) casePatternParen += 1;
            else depth += 1;
          } else if (c === ')') {
            if (caseDepth > 0) {
              if (casePatternParen > 0) casePatternParen -= 1;
            } else {
              depth -= 1;
            }
          }
        }
        j++;
      }
      if (depth === 0) {
        bodies.push(script.slice(i + 2, j - 1));
        i = j;
        continue;
      }
    }
    if (ch === '`') {
      let j = i + 1;
      let body = '';
      while (j < script.length && script[j] !== '`') {
        if (
          script[j] === '\\' &&
          j + 1 < script.length &&
          (script[j + 1] === '`' || script[j + 1] === '\\' || script[j + 1] === '$')
        ) {
          body += script[j + 1]!;
          j += 2;
          continue;
        }
        body += script[j]!;
        j++;
      }
      if (j < script.length) {
        bodies.push(body);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return bodies;
}

/**
 * Split a GNU `env -S` / `--split-string` argument into tokens; returns
 * `'unclassified'` on unclosed quotes or `${...}` / `$VAR` expansions.
 */
export function splitEnvSplitString(raw: string): FlatScriptTokens {
  const tokens: ShellToken[] = [];
  let current = '';
  let inToken = false;
  let isQuoted = false;
  let i = 0;

  const flush = (): void => {
    if (inToken) {
      tokens.push({ value: current, hasDynamicExpansion: false, hasUnquotedGlob: false, isQuoted });
      current = '';
      inToken = false;
      isQuoted = false;
    }
  };

  while (i < raw.length) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    if (ch === '$') return { kind: 'unclassified' };
    inToken = true;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      isQuoted = true;
      i++;
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === '$' && quote === '"') return { kind: 'unclassified' };
        if (raw[i] === '\\') {
          if (i + 1 >= raw.length) return { kind: 'unclassified' };
          current += raw[i + 1]!;
          i += 2;
          continue;
        }
        current += raw[i]!;
        i++;
      }
      if (i >= raw.length) return { kind: 'unclassified' };
      i++;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= raw.length) return { kind: 'unclassified' };
      current += raw[i + 1]!;
      i += 2;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return { kind: 'classified', tokens };
}
