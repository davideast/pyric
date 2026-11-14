/**
 * POSIX shell command-string tokenization, unquoted operator splitting, and
 * `$(...)` / backtick command-substitution extraction for unsupported-runtime
 * child command inspection.
 */

/** Tokens that end one command and begin the next inside a shell string. */
export const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

/** Grouping tokens that leave the parser at the start of a command. */
export const COMMAND_GROUP_TOKENS = new Set(['(', ')', '{', '}']);

/** Leading `KEY=VAL` environment assignments in a shell command. */
export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split unquoted shell operators and subshell parentheses inside a single
 * whitespace-free argv token (e.g. `b;`, `false||deno`, `(bun`), while leaving
 * quoted/multi-word arguments, `KEY=VAL` assignments, `--flag=val` options, and
 * URLs intact.
 */
export function expandUnquotedOperators(token: string): string[] {
  if (
    token.length === 0 ||
    SHELL_OPERATORS.has(token) ||
    COMMAND_GROUP_TOKENS.has(token) ||
    /\s/.test(token) ||
    ENV_ASSIGNMENT.test(token) ||
    /^--[A-Za-z0-9_-]+=/.test(token) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)
  ) {
    return [token];
  }

  const out: string[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < token.length) {
    const ch = token[i]!;
    const two = token.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      out.push(two);
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      out.push(ch);
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Tokenize a shell `-c` / `env -S` script string into words and unquoted shell
 * operators while keeping single- and double-quoted segments attached.
 */
export function tokenizeShellScript(script: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;

  const flush = (): void => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };

  while (i < script.length) {
    const ch = script[i]!;
    if (ch === '\n' || ch === '\r') {
      flush();
      tokens.push(';');
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      tokens.push(two);
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      tokens.push(ch);
      i++;
      continue;
    }
    inToken = true;
    if (ch === "'") {
      i++;
      while (i < script.length && script[i] !== "'") {
        current += script[i]!;
        i++;
      }
      if (i < script.length) i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length && (script[i + 1] === '"' || script[i + 1] === '\\')) {
          current += script[i + 1]!;
          i += 2;
          continue;
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
    current += ch;
    i++;
  }
  flush();
  return tokens;
}

/**
 * Extract POSIX `$(...)` and backtick `` `...` `` command substitution bodies
 * from unquoted and double-quoted segments of a shell script (ignoring
 * single-quoted literals where POSIX shells never expand substitutions).
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
    if (ch === '$' && script[i + 1] === '(' && script[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      let subSingle = false;
      let subDouble = false;
      while (j < script.length && depth > 0) {
        const c = script[j]!;
        if (!subDouble && c === "'") {
          subSingle = !subSingle;
          j++;
          continue;
        }
        if (!subSingle && c === '\\' && j + 1 < script.length) {
          j += 2;
          continue;
        }
        if (!subSingle && c === '"') {
          subDouble = !subDouble;
          j++;
          continue;
        }
        if (!subSingle && !subDouble) {
          if (c === '(') depth++;
          else if (c === ')') depth--;
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
