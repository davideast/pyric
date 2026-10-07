/**
 * Source positions for rule nodes in `database.rules.json`.
 *
 * Realtime Database rules files accept `//` and block comments. The scanner
 * below reads JSON with comments and records the position of every object key,
 * so a rule node addressed by its rule-tree path and kind resolves to the line
 * and column of its key. Comments and string contents never produce keys.
 */

import type { RtdbRuleEvaluation } from './simulation/spec.js';

export type RtdbRuleKind = '.read' | '.write' | '.validate' | '.indexOn';

export interface RtdbSourceLocation {
  /** 1-based line of the rule key. */
  line: number;
  /** 1-based column of the opening quote of the rule key. */
  column: number;
}

interface KeyEntry {
  location: RtdbSourceLocation;
  value: ScannedValue;
}

/** An object maps keys to entries; any other value is a leaf. */
type ScannedValue = Map<string, KeyEntry> | null;

class Scanner {
  private pos = 0;
  private line = 1;
  private lineStart = 0;

  constructor(private readonly text: string) {}

  /** Parses a whole document; returns null when the text is not valid JSONC. */
  parseDocument(): ScannedValue | undefined {
    try {
      this.skipTrivia();
      const value = this.parseValue();
      this.skipTrivia();
      if (this.pos < this.text.length) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private newline(): void {
    this.line++;
    this.lineStart = this.pos;
  }

  private skipTrivia(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === '\n') {
        this.pos++;
        this.newline();
      } else if (c === '\r') {
        this.pos++;
        if (t[this.pos] === '\n') this.pos++;
        this.newline();
      } else if (c === ' ' || c === '\t' || c === '﻿') {
        this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '/') {
        while (this.pos < t.length && t[this.pos] !== '\n' && t[this.pos] !== '\r') this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '*') {
        this.pos += 2;
        for (;;) {
          if (this.pos >= t.length) throw new Error('unterminated comment');
          const d = t[this.pos];
          if (d === '*' && t[this.pos + 1] === '/') {
            this.pos += 2;
            break;
          }
          this.pos++;
          if (d === '\n') this.newline();
          else if (d === '\r') {
            if (t[this.pos] === '\n') this.pos++;
            this.newline();
          }
        }
      } else {
        return;
      }
    }
  }

  private parseValue(): ScannedValue {
    const c = this.text[this.pos];
    if (c === '{') return this.parseObject();
    if (c === '[') {
      this.parseArray();
      return null;
    }
    if (c === '"') {
      this.parseString();
      return null;
    }
    this.parseLiteral();
    return null;
  }

  private parseObject(): Map<string, KeyEntry> {
    const entries = new Map<string, KeyEntry>();
    this.pos++;
    this.skipTrivia();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return entries;
    }
    for (;;) {
      this.skipTrivia();
      if (this.text[this.pos] !== '"') throw new Error('expected key');
      const location = { line: this.line, column: this.pos - this.lineStart + 1 };
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.pos] !== ':') throw new Error('expected colon');
      this.pos++;
      this.skipTrivia();
      const value = this.parseValue();
      entries.set(key, { location, value });
      this.skipTrivia();
      const next = this.text[this.pos++];
      if (next === '}') return entries;
      if (next !== ',') throw new Error('expected comma');
    }
  }

  private parseArray(): void {
    this.pos++;
    this.skipTrivia();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return;
    }
    for (;;) {
      this.skipTrivia();
      this.parseValue();
      this.skipTrivia();
      const next = this.text[this.pos++];
      if (next === ']') return;
      if (next !== ',') throw new Error('expected comma');
    }
  }

  private parseString(): string {
    const t = this.text;
    const start = this.pos;
    this.pos++;
    for (;;) {
      if (this.pos >= t.length) throw new Error('unterminated string');
      const c = t[this.pos];
      if (c === '\\') {
        this.pos += 2;
      } else if (c === '"') {
        this.pos++;
        break;
      } else if (c === '\n' || c === '\r') {
        throw new Error('newline in string');
      } else {
        this.pos++;
      }
    }
    return JSON.parse(t.slice(start, this.pos)) as string;
  }

  private parseLiteral(): void {
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      this.text.slice(this.pos, this.pos + 64),
    );
    if (!match) throw new Error('unexpected token');
    this.pos += match[0].length;
  }
}

function locateIn(
  root: Exclude<ScannedValue, null>,
  path: string,
  kind: RtdbRuleKind,
): RtdbSourceLocation | null {
  let node: ScannedValue = root.get('rules')?.value ?? null;
  for (const segment of path.split('/').filter((s) => s.length > 0)) {
    node = node?.get(segment)?.value ?? null;
  }
  return node?.get(kind)?.location ?? null;
}

/**
 * Finds the line and column of a rule key in `database.rules.json` source text.
 *
 * `path` is the rule-tree path of the node, for example `/rooms/$roomId`
 * (leading and trailing slashes optional; `$wildcard` segments are written
 * as they appear in the file). `kind` is the rule key. Returns null when the
 * text is not valid JSON with comments, or the path or key is absent. When a
 * key is duplicated the last occurrence is reported, matching `JSON.parse`.
 */
export function locateRtdbRule(
  source: string,
  path: string,
  kind: RtdbRuleKind,
): RtdbSourceLocation | null {
  const root = new Scanner(source).parseDocument();
  if (!root) return null;
  return locateIn(root, path, kind);
}

/** An evaluation-trace entry with the line of its rule in the rules file. */
export type LocatedRtdbRuleEvaluation = Located<RtdbRuleEvaluation>;

/** A rule node addressed by its rule-tree path and its kind without the dot. */
export interface RtdbRuleAddress {
  path: string;
  kind: 'read' | 'write' | 'validate' | 'indexOn';
}

/** An entry with the line of its rule in the rules file. */
export type Located<T> = T & {
  /** 1-based line of the rule key. Absent when the source does not contain the rule. */
  line?: number;
};

/**
 * Attaches to each entry the line of the rule it addresses: the evaluation
 * trace of a request, or any other list of rule nodes. The source is scanned
 * once for the whole list. An entry whose rule the source does not contain,
 * or every entry when the text is not valid JSON with comments, carries no
 * `line`.
 */
export function locateRtdbTrace<T extends RtdbRuleAddress>(
  source: string,
  trace: readonly T[],
): Located<T>[] {
  const root = new Scanner(source).parseDocument();
  return trace.map((entry) => {
    const location = root ? locateIn(root, entry.path, `.${entry.kind}`) : null;
    return location ? { ...entry, line: location.line } : { ...entry };
  });
}
