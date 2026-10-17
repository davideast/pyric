import { normalizeRe2ForJsRegExp } from '../grammar/re2-pattern.js';
import { FirestoreSet } from './firestore-set.js';
import { MapDiff } from './mapdiff.js';
import { RulesValue } from './wrappers/base.js';

/** A Rules map is a plain key/value record, never a boxed scalar/wrapper. */
export function isRulesMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The Rules type name of a value, as production's error messages spell it. */
export function describeRulesType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof RulesValue) return value.typeName;
  if (value instanceof FirestoreSet) return 'set';
  if (value instanceof MapDiff) return 'map_diff';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'list';
  if (isRulesMap(value)) return 'map';
  return typeof value;
}

// ═══ Linear-time RE2 regex evaluation & Java Matcher replacement ═══

type RegexNode =
  | { kind: 'empty' }
  | { kind: 'char'; test: (ch: string) => boolean }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean }
  | { kind: 'seq'; items: RegexNode[] }
  | { kind: 'alt'; left: RegexNode; right: RegexNode }
  | { kind: 'rep'; body: RegexNode; min: number; max: number };

type NfaState =
  | { kind: 'char'; test: (ch: string) => boolean; out: number }
  | { kind: 'assert'; check: (chars: readonly string[], pos: number) => boolean; out: number }
  | { kind: 'split'; out1: number; out2: number }
  | { kind: 'accept' };

function isWordChar(chars: readonly string[], idx: number): boolean {
  if (idx < 0 || idx >= chars.length) return false;
  const ch = chars[idx]!;
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/**
 * Validate and compile a rules RE2 pattern into a JS RegExp for `split` or
 * `replace`, rejecting backreferences and lookaround constructs that RE2
 * rejects in production.
 */
export function compileRe2Regex(method: string, pattern: string, source: string, flags?: string): RegExp {
  const backref = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?<?[=!]/.test(pattern);
  if (backref || lookaround) {
    const kind = backref ? 'backreference' : 'lookaround';
    throw new Error(
      `${method}() pattern uses an RE2-unsupported construct (${kind}) that production would reject`,
    );
  }
  try {
    return new RegExp(normalizeRe2ForJsRegExp(source), flags);
  } catch (err) {
    throw new Error(`Invalid regex '${pattern}' in ${method}(): ${(err as Error).message}`);
  }
}

/**
 * Evaluate `subject.matches(pattern)` (full-string RE2 match) in guaranteed
 * O(M * N) time using a Thompson NFA state-set simulation so patterns with
 * nested quantifiers like `((a+)+)b` never backtrack catastrophically.
 */
export function re2FullMatch(pattern: string, subject: string): boolean {
  compileRe2Regex('matches', pattern, `^(?:${pattern})$`);
  const ast = parseRe2Ast(pattern);
  const states: NfaState[] = [{ kind: 'accept' }];
  const addState = (st: NfaState): number => {
    const id = states.length;
    states.push(st);
    return id;
  };
  const emit = (node: RegexNode, out: number): number => {
    switch (node.kind) {
      case 'empty':
        return out;
      case 'char':
        return addState({ kind: 'char', test: node.test, out });
      case 'assert':
        return addState({ kind: 'assert', check: node.check, out });
      case 'seq': {
        let cur = out;
        for (let i = node.items.length - 1; i >= 0; i--) {
          cur = emit(node.items[i]!, cur);
        }
        return cur;
      }
      case 'alt': {
        const a = emit(node.left, out);
        const b = emit(node.right, out);
        return addState({ kind: 'split', out1: a, out2: b });
      }
      case 'rep': {
        let tail = out;
        if (node.max === Infinity) {
          const splitId = addState({ kind: 'split', out1: 0, out2: out });
          const loopBody = emit(node.body, splitId);
          states[splitId] = { kind: 'split', out1: loopBody, out2: out };
          tail = splitId;
        } else {
          for (let k = node.min; k < node.max; k++) {
            const optBody = emit(node.body, tail);
            tail = addState({ kind: 'split', out1: optBody, out2: tail });
          }
        }
        for (let k = node.min - 1; k >= 0; k--) {
          tail = emit(node.body, tail);
        }
        return tail;
      }
    }
  };

  const chars = Array.from(subject);
  const startState = emit(ast, 0);
  let current = epsilonClosure([startState], states, chars, 0);
  for (let pos = 0; pos < chars.length && current.length > 0; pos++) {
    const ch = chars[pos]!;
    const nextSeeds: number[] = [];
    for (const id of current) {
      const st = states[id]!;
      if (st.kind === 'char' && st.test(ch)) {
        nextSeeds.push(st.out);
      }
    }
    current = epsilonClosure(nextSeeds, states, chars, pos + 1);
  }
  return current.includes(0);
}

function epsilonClosure(
  seeds: readonly number[],
  states: readonly NfaState[],
  chars: readonly string[],
  pos: number,
): number[] {
  const visited = new Uint8Array(states.length);
  const stack = [...seeds];
  const active: number[] = [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited[id]) continue;
    visited[id] = 1;
    const st = states[id]!;
    if (st.kind === 'split') {
      stack.push(st.out1, st.out2);
    } else if (st.kind === 'assert') {
      if (st.check(chars, pos)) stack.push(st.out);
    } else {
      active.push(id);
    }
  }
  return active;
}

function compileCharMatcher(rawPattern: string, ignoreCase: boolean): (ch: string) => boolean {
  let flags = 'u';
  if (ignoreCase) flags = 'iu';
  try {
    const re = new RegExp(`^${rawPattern}$`, flags);
    return (c) => re.test(c);
  } catch {
    const fallbackFlags = ignoreCase ? 'i' : '';
    const re = new RegExp(`^${rawPattern}$`, fallbackFlags);
    return (c) => re.test(c);
  }
}

function parseRe2Ast(pattern: string): RegexNode {
  let pos = 0;
  let ignoreCase = false;
  let multiline = false;
  let dotAll = false;

  const applyFlagString = (flagStr: string) => {
    let clearing = false;
    for (const f of flagStr) {
      if (f === '-') clearing = true;
      else if (f === 'i') ignoreCase = !clearing;
      else if (f === 'm') multiline = !clearing;
      else if (f === 's') dotAll = !clearing;
    }
  };

  const parseAlternation = (): RegexNode => {
    let left = parseConcat();
    while (pos < pattern.length && pattern[pos] === '|') {
      pos++;
      const right = parseConcat();
      left = { kind: 'alt', left, right };
    }
    return left;
  };

  const parseConcat = (): RegexNode => {
    const items: RegexNode[] = [];
    while (pos < pattern.length && pattern[pos] !== '|' && pattern[pos] !== ')') {
      items.push(parseQuantified());
    }
    if (items.length === 0) return { kind: 'empty' };
    if (items.length === 1) return items[0]!;
    return { kind: 'seq', items };
  };

  const parseQuantified = (): RegexNode => {
    let node = parseAtom();
    while (pos < pattern.length) {
      const ch = pattern[pos];
      if (ch === '*' || ch === '+' || ch === '?') {
        pos++;
        if (pos < pattern.length && pattern[pos] === '?') pos++;
        let min = 0;
        let max = Infinity;
        if (ch === '+') min = 1;
        else if (ch === '?') max = 1;
        node = { kind: 'rep', body: node, min, max };
      } else if (ch === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(pos));
        if (!m) break;
        pos += m[0].length;
        if (pos < pattern.length && pattern[pos] === '?') pos++;
        const min = Number(m[1]);
        let max = min;
        if (m[2] !== undefined) {
          max = m[2] === '' ? Infinity : Number(m[2]);
        }
        if (min > max || min > 1000 || (max !== Infinity && max > 1000)) {
          throw new Error(`Invalid repeat count in '${pattern}'`);
        }
        node = { kind: 'rep', body: node, min, max };
      } else {
        break;
      }
    }
    return node;
  };

  const matchLiteralChar = (target: string, caseInsensitive: boolean): RegexNode => {
    if (caseInsensitive) {
      const lo = target.toLowerCase();
      const up = target.toUpperCase();
      return { kind: 'char', test: (c) => c === lo || c === up };
    }
    return { kind: 'char', test: (c) => c === target };
  };

  const parseAtom = (): RegexNode => {
    const ch = pattern[pos]!;
    if (ch === '(') {
      pos++;
      const savedI = ignoreCase;
      const savedM = multiline;
      const savedS = dotAll;
      if (pattern[pos] === '?') {
        pos++;
        if (pattern[pos] === ':') {
          pos++;
        } else if (pattern[pos] === '<' || (pattern[pos] === 'P' && pattern[pos + 1] === '<')) {
          const closeGt = pattern.indexOf('>', pos);
          pos = closeGt + 1;
        } else {
          const flagMatch = /^[imsU-]+/.exec(pattern.slice(pos));
          if (flagMatch) {
            applyFlagString(flagMatch[0]);
            pos += flagMatch[0].length;
            if (pattern[pos] === ')') {
              pos++;
              return { kind: 'empty' };
            }
            if (pattern[pos] === ':') pos++;
          }
        }
      }
      const inner = parseAlternation();
      if (pattern[pos] === ')') pos++;
      ignoreCase = savedI;
      multiline = savedM;
      dotAll = savedS;
      return inner;
    }
    if (ch === '[') {
      const start = pos;
      pos++;
      if (pattern[pos] === '^') pos++;
      if (pattern[pos] === ']') pos++;
      while (pos < pattern.length && pattern[pos] !== ']') {
        if (pattern[pos] === '\\') pos += 2;
        else pos++;
      }
      if (pattern[pos] === ']') pos++;
      const rawClass = normalizeRe2ForJsRegExp(pattern.slice(start, pos));
      return { kind: 'char', test: compileCharMatcher(rawClass, ignoreCase) };
    }
    if (ch === '^') {
      pos++;
      const isMulti = multiline;
      return {
        kind: 'assert',
        check: (s, p) => p === 0 || (isMulti && p > 0 && s[p - 1] === '\n'),
      };
    }
    if (ch === '$') {
      pos++;
      const isMulti = multiline;
      return {
        kind: 'assert',
        check: (s, p) => p === s.length || (isMulti && p < s.length && s[p] === '\n'),
      };
    }
    if (ch === '.') {
      pos++;
      const allowNl = dotAll;
      return { kind: 'char', test: (c) => allowNl || (c !== '\n' && c !== '\r') };
    }
    if (ch === '\\') {
      const start = pos;
      pos++;
      const esc = pattern[pos]!;
      if (esc === 'b') {
        pos++;
        return { kind: 'assert', check: (s, p) => isWordChar(s, p - 1) !== isWordChar(s, p) };
      }
      if (esc === 'B') {
        pos++;
        return { kind: 'assert', check: (s, p) => isWordChar(s, p - 1) === isWordChar(s, p) };
      }
      if (esc === 'A') {
        pos++;
        return { kind: 'assert', check: (_s, p) => p === 0 };
      }
      if (esc === 'z') {
        pos++;
        return { kind: 'assert', check: (s, p) => p === s.length };
      }
      if ((esc === 'x' || esc === 'u') && pattern[pos + 1] === '{') {
        const closeBrace = pattern.indexOf('}', pos + 2);
        const hex = pattern.slice(pos + 2, closeBrace);
        pos = closeBrace + 1;
        return matchLiteralChar(String.fromCodePoint(parseInt(hex, 16)), ignoreCase);
      }
      if ((esc === 'p' || esc === 'P') && pattern[pos + 1] === '{') {
        const closeBrace = pattern.indexOf('}', pos + 2);
        pos = closeBrace + 1;
        const rawEsc = pattern.slice(start, pos);
        return { kind: 'char', test: compileCharMatcher(rawEsc, ignoreCase) };
      }
      if (esc === 'd' || esc === 'D' || esc === 'w' || esc === 'W' || esc === 's' || esc === 'S' || esc === 't' || esc === 'n' || esc === 'r' || esc === 'v' || esc === 'f') {
        pos++;
        const rawEsc = pattern.slice(start, pos);
        return { kind: 'char', test: compileCharMatcher(rawEsc, ignoreCase) };
      }
      if (esc === 'x') {
        pos += 3;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      if (esc === 'u') {
        pos += 5;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      if (esc === 'c') {
        pos += 2;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      if (esc >= '0' && esc <= '7') {
        const oct = /^[0-7]{1,3}/.exec(pattern.slice(pos))!;
        pos += oct[0].length;
        return { kind: 'char', test: compileCharMatcher(pattern.slice(start, pos), ignoreCase) };
      }
      const cp = pattern.codePointAt(pos)!;
      const lit = String.fromCodePoint(cp);
      pos += lit.length;
      return matchLiteralChar(lit, ignoreCase);
    }
    const cp = pattern.codePointAt(pos)!;
    const fullCh = String.fromCodePoint(cp);
    pos += fullCh.length;
    return matchLiteralChar(fullCh, ignoreCase);
  };

  return parseAlternation();
}

/**
 * Evaluate `subject.replace(pattern, replacement)` with RE2 regex compilation
 * and Java `Matcher` replacement template rules (`$n`, `${name}`, `\c`).
 */
export function replaceRe2(subject: string, pattern: string, replacement: string): string {
  const regex = compileRe2Regex('replace', pattern, pattern, 'g');
  const probe = new RegExp(`${regex.source}|`).exec('');
  const groupCount = probe === null ? 0 : probe.length - 1;
  return subject.replace(regex, (...match: unknown[]) => {
    const groups = match.slice(0, groupCount + 1) as Array<string | undefined>;
    const lastArg = match[match.length - 1];
    let namedGroups: Record<string, string | undefined> = {};
    if (typeof lastArg === 'object' && lastArg !== null) {
      namedGroups = lastArg as Record<string, string | undefined>;
    }
    return expandRe2Replacement(replacement, groups, namedGroups);
  });
}

function expandRe2Replacement(
  template: string,
  groups: ReadonlyArray<string | undefined>,
  namedGroups: Readonly<Record<string, string | undefined>>,
): string {
  const groupCount = groups.length - 1;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char === '\\') {
      if (i + 1 >= template.length) {
        throw new Error('replace() replacement ends with an escape character');
      }
      out += template[i + 1];
      i += 2;
      continue;
    }
    if (char !== '$') {
      out += char;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      if (close === -1) {
        throw new Error(`replace() replacement has an unclosed group name: ${template.slice(i)}`);
      }
      const name = template.slice(i + 2, close);
      if (!Object.hasOwn(namedGroups, name)) {
        throw new Error(`replace() replacement names no group: ${template.slice(i, close + 1)}`);
      }
      out += namedGroups[name] ?? '';
      i = close + 1;
      continue;
    }
    if (next === undefined || next < '0' || next > '9') {
      throw new Error(`replace() replacement has an illegal group reference: ${template.slice(i)}`);
    }
    let group = Number(next);
    let end = i + 2;
    while (end < template.length && template[end]! >= '0' && template[end]! <= '9') {
      const longer = group * 10 + Number(template[end]);
      if (longer > groupCount) break;
      group = longer;
      end += 1;
    }
    if (group > groupCount) {
      throw new Error(`replace() replacement names group ${group}, but the pattern has ${groupCount}`);
    }
    out += groups[group] ?? '';
    i = end;
  }
  return out;
}
