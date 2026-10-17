/**
 * Normalize RE2-specific syntax (`(?i)`, `(?i:...)`, `(?P<name>...)`, `\A`,
 * `\z`, `\x{...}`, and leading `]` inside `[...]`) into a form JS `new RegExp`
 * can syntax-check without rejecting valid RE2 patterns.
 */
export function normalizeRe2ForJsRegExp(source: string): string {
  let out = '';
  let i = 0;
  let inClass = false;
  let classStart = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        out += '\\';
        break;
      }
      if (!inClass && next === 'A') {
        out += '^';
        i += 2;
        continue;
      }
      if (!inClass && next === 'z') {
        out += '$';
        i += 2;
        continue;
      }
      if ((next === 'x' || next === 'u') && source[i + 2] === '{') {
        const close = source.indexOf('}', i + 3);
        if (close !== -1) {
          const hex = source.slice(i + 3, close);
          if (/^[0-9A-Fa-f]+$/.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            i = close + 1;
            classStart = false;
            continue;
          }
        }
      }
      out += source.slice(i, i + 2);
      i += 2;
      classStart = false;
      continue;
    }
    if (inClass) {
      if (ch === ']' && classStart) {
        out += '\\]';
        i++;
        classStart = false;
        continue;
      }
      if (ch === ']') {
        inClass = false;
      }
      out += ch;
      i++;
      classStart = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += '[';
      i++;
      if (source[i] === '^') {
        out += '^';
        i++;
      }
      classStart = true;
      continue;
    }
    if (ch === '(' && source[i + 1] === '?') {
      const rest = source.slice(i + 2);
      const named = /^P<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
      if (named) {
        out += `(?<${named[1]}>`;
        i += 2 + named[0].length;
        continue;
      }
      const scopedFlags = /^([imsU-]+):/.exec(rest);
      if (scopedFlags) {
        out += '(?:';
        i += 2 + scopedFlags[0].length;
        continue;
      }
      const inlineFlags = /^([imsU-]+)\)/.exec(rest);
      if (inlineFlags) {
        const afterClose = source[i + 2 + inlineFlags[0].length];
        if (afterClose === '*' || afterClose === '+' || afterClose === '?' || afterClose === '{') {
          throw new Error('Nothing to repeat after inline flag group');
        }
        out += '(?:)';
        i += 2 + inlineFlags[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
