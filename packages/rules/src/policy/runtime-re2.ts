// Embedded zero-dependency linear-time Thompson NFA RE2 regex engine for standalone ES modules.
// Guarantees O(states * chars) matching, splitting, and replacement with zero backtracking
// and explicit tick accounting against the standalone evaluation budget.
import { boundedRe2FoldRuntime } from './runtime-re2-fold.js';

export const boundedRe2Runtime = `  const RE2_MAX_STATES = 20000;
${boundedRe2FoldRuntime}
  function re2Word(c) {
    if (!c || c.length !== 1) return false;
    const k = c.charCodeAt(0);
    return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95;
  }
  function re2PosixSpace(c) {
    return c === ' ' || c === '\\t' || c === '\\n' || c === '\\r' || c === '\\f' || c === '\\v';
  }
  function re2PerlSpace(c) {
    return c === ' ' || c === '\\t' || c === '\\n' || c === '\\r' || c === '\\f';
  }
  function re2IsAsciiAlnum(c) {
    if (!c || c.length !== 1) return false;
    const k = c.charCodeAt(0);
    return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
  }
  function re2Posix(name) {
    switch (name) {
      case 'alnum': return (c) => /^[0-9A-Za-z]$/.test(c);
      case 'alpha': return (c) => /^[A-Za-z]$/.test(c);
      case 'ascii': return (c) => c.length === 1 && c.charCodeAt(0) <= 127;
      case 'blank': return (c) => c === ' ' || c === '\\t';
      case 'cntrl': return (c) => c.length === 1 && (c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127);
      case 'digit': return (c) => c >= '0' && c <= '9';
      case 'graph': return (c) => c.length === 1 && c.charCodeAt(0) >= 33 && c.charCodeAt(0) <= 126;
      case 'lower': return (c) => c >= 'a' && c <= 'z';
      case 'print': return (c) => c.length === 1 && c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126;
      case 'punct': return (c) => /^[!-\\/:-@\\[-\\\`{-~]$/.test(c);
      case 'space': return re2PosixSpace;
      case 'upper': return (c) => c >= 'A' && c <= 'Z';
      case 'word': return re2Word;
      case 'xdigit': return (c) => /^[0-9A-Fa-f]$/.test(c);
      default: fail('Unknown POSIX class: ' + name);
    }
  }
  function re2UnicodeProp(spec, neg, ci) {
    if (!spec) fail('Invalid Unicode property class');
    const hasCaret = spec[0] === '^';
    const name = hasCaret ? spec.slice(1) : spec;
    if (!/^[A-Za-z_]+$/.test(name)) fail('Invalid Unicode property class: ' + spec);
    const prop = RE2_GEN_CATS.has(name) ? name : 'Script=' + name;
    const inv = neg !== hasCaret;
    let re;
    try { re = new RegExp('^\\\\p{' + prop + '}$', 'u'); }
    catch { fail('Invalid Unicode property class: ' + spec); }
    return (c) => {
      const hit = ci ? re2Orbit(c).some((p) => re.test(p)) : re.test(c);
      return inv ? !hit : hit;
    };
  }
  function re2Octal(pat, pos, inClass) {
    const rest = pat.slice(pos);
    const m3 = /^[0-3][0-7]{2}/.exec(rest);
    if (m3) return [String.fromCodePoint(parseInt(m3[0], 8)), pos + 3];
    if (inClass) {
      const m2 = /^[1-7][0-7]/.exec(rest);
      if (m2) return [String.fromCodePoint(parseInt(m2[0], 8)), pos + 2];
    }
    const m0 = /^0[0-7]{0,2}/.exec(rest);
    if (m0) return [String.fromCodePoint(parseInt(m0[0], 8)), pos + m0[0].length];
    return null;
  }
  function re2EscapeChar(pat, pos, inClass) {
    if (pos >= pat.length) fail('Trailing backslash in regex');
    const c = pat[pos];
    if (c === 't') return ['\\t', pos + 1];
    if (c === 'n') return ['\\n', pos + 1];
    if (c === 'r') return ['\\r', pos + 1];
    if (c === 'f') return ['\\f', pos + 1];
    if (c === 'v') return ['\\v', pos + 1];
    if (c === 'a') return ['\\x07', pos + 1];
    const oct = re2Octal(pat, pos, inClass);
    if (oct) return oct;
    if (c === 'x') {
      if (pat[pos + 1] === '{') {
        const end = pat.indexOf('}', pos + 2);
        if (end === -1) fail('Unclosed hex escape');
        const hex = pat.slice(pos + 2, end);
        if (!/^[0-9A-Fa-f]{1,8}$/.test(hex)) fail('Invalid hex escape');
        const cp = parseInt(hex, 16);
        if (!Number.isSafeInteger(cp) || cp > 0x10ffff) fail('Hex escape out of Unicode range');
        return [String.fromCodePoint(cp), end + 1];
      }
      const hex = pat.slice(pos + 1, pos + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) fail('Invalid hex escape');
      return [String.fromCharCode(parseInt(hex, 16)), pos + 3];
    }
    if (re2IsAsciiAlnum(c)) fail('Invalid escape sequence: \\\\' + c);
    const cp = pat.codePointAt(pos);
    const ch = String.fromCodePoint(cp);
    return [ch, pos + ch.length];
  }
  function re2FoldEq(a, b, ci) {
    if (!ci || a === b) return a === b;
    return re2Orbit(a).includes(b);
  }
  function re2ClassTest(pat, start, ci) {
    let pos = start + 1;
    const neg = pat[pos] === '^';
    if (neg) pos++;
    const tests = [];
    const readAtom = () => {
      if (pat[pos] === '\\\\') {
        const nx = pat[pos + 1];
        if (nx === 'd' || nx === 'D' || nx === 'w' || nx === 'W' || nx === 's' || nx === 'S') {
          pos += 2;
          return { fn: re2ShortClass(nx) };
        }
        if ((nx === 'p' || nx === 'P') && pat[pos + 2] === '{') {
          const end = pat.indexOf('}', pos + 3);
          if (end === -1) fail('Unclosed Unicode property class');
          const spec = pat.slice(pos + 3, end);
          pos = end + 1;
          return { fn: re2UnicodeProp(spec, nx === 'P', ci) };
        }
        if ((nx === 'p' || nx === 'P') && /[A-Za-z]/.test(pat[pos + 2] || '')) {
          const spec = pat[pos + 2];
          if (!RE2_SHORT_CATS.has(spec)) fail('Invalid Unicode property class: \\\\' + nx + spec);
          pos += 3;
          return { fn: re2UnicodeProp(spec, nx === 'P', ci) };
        }
        const [ch, nextPos] = re2EscapeChar(pat, pos + 1, true);
        pos = nextPos;
        return { ch };
      }
      const cp = pat.codePointAt(pos);
      const ch = String.fromCodePoint(cp);
      pos += ch.length;
      return { ch };
    };
    let first = true;
    while (pos < pat.length && (first || pat[pos] !== ']')) {
      first = false;
      const pm = /^\\[:(\\^?)([^:\\]]*):\\]/.exec(pat.slice(pos));
      if (pm) {
        const base = re2Posix(pm[2]);
        const inv = pm[1] === '^';
        tests.push((c) => {
          const hit = ci ? re2Orbit(c).some((p) => base(p)) : base(c);
          return inv ? !hit : hit;
        });
        pos += pm[0].length;
        continue;
      }
      const left = readAtom();
      if (left.ch !== undefined && pat[pos] === '-' && pat[pos + 1] !== undefined && pat[pos + 1] !== ']') {
        pos++;
        const right = readAtom();
        if (right.ch === undefined) fail('Invalid character class range');
        const lo = left.ch.codePointAt(0), hi = right.ch.codePointAt(0);
        if (lo > hi) fail('Invalid character class range');
        tests.push((c) => {
          const cp = c.codePointAt(0);
          if (cp >= lo && cp <= hi) return true;
          if (!ci) return false;
          return re2Orbit(c).some((p) => { const pc = p.codePointAt(0); return pc >= lo && pc <= hi; });
        });
      } else if (left.fn) {
        tests.push(left.fn);
      } else {
        const target = left.ch;
        tests.push((c) => re2FoldEq(c, target, ci));
      }
    }
    if (pat[pos] !== ']') fail('Unclosed character class');
    const fn = (c) => {
      const hit = tests.some((t) => t(c));
      return neg ? !hit : hit;
    };
    return [fn, pos + 1];
  }
  function re2ShortClass(esc) {
    if (esc === 'd') return (c) => c >= '0' && c <= '9';
    if (esc === 'D') return (c) => !(c >= '0' && c <= '9');
    if (esc === 'w') return re2Word;
    if (esc === 'W') return (c) => !re2Word(c);
    if (esc === 's') return re2PerlSpace;
    return (c) => !re2PerlSpace(c);
  }
  function re2Parse(pat) {
    let pos = 0, ci = false, ml = false, dotAll = false, ungreedy = false, groups = 0;
    const named = Object.create(null);
    const applyFlags = (fl) => {
      let off = false;
      for (const f of fl) {
        if (f === '-') off = true;
        else if (f === 'i') ci = !off;
        else if (f === 'm') ml = !off;
        else if (f === 's') dotAll = !off;
        else if (f === 'U') ungreedy = !off;
        else fail('Unsupported regex flag: ' + f);
      }
    };
    const parseAlt = () => {
      let left = parseSeq();
      while (pos < pat.length && pat[pos] === '|') {
        pos++;
        left = { k: 'alt', a: left, b: parseSeq() };
      }
      return left;
    };
    const parseSeq = () => {
      const items = [];
      while (pos < pat.length && pat[pos] !== '|' && pat[pos] !== ')') {
        if (pat.startsWith('\\\\Q', pos)) {
          const end = pat.indexOf('\\\\E', pos + 2);
          const stop = end === -1 ? pat.length : end;
          const f = ci;
          const lits = Array.from(pat.slice(pos + 2, stop)).map((ch) => ({ k: 'ch', fn: (c) => re2FoldEq(c, ch, f) }));
          pos = end === -1 ? stop : end + 2;
          const last = lits.pop();
          if (last) { items.push(...lits, parseQuant(last)); }
        } else {
          items.push(parseQuant());
        }
      }
      if (items.length === 0) return { k: 'empty' };
      return items.length === 1 ? items[0] : { k: 'seq', items };
    };
    const isQuantAt = (i) => {
      const c = pat[i];
      return c === '*' || c === '+' || c === '?' || (c === '{' && /^\\{\\d+(?:,\\d*)?\\}/.test(pat.slice(i)));
    };
    const parseQuant = (preset) => {
      const node = preset || parseAtom();
      if (pos >= pat.length || !isQuantAt(pos)) return node;
      if (node.k === 'as' || node.noQ) fail('Invalid regular expression: nothing to repeat');
      const ch = pat[pos];
      let min, max;
      if (ch === '*' || ch === '+' || ch === '?') {
        pos++;
        min = ch === '+' ? 1 : 0;
        max = ch === '?' ? 1 : Infinity;
      } else {
        const m = /^\\{(\\d+)(?:,(\\d*))?\\}/.exec(pat.slice(pos));
        pos += m[0].length;
        min = Number(m[1]);
        max = m[2] === undefined ? min : (m[2] === '' ? Infinity : Number(m[2]));
        if (min > max || min > 1000 || (max !== Infinity && max > 1000)) fail('Invalid repeat count');
      }
      const lazy = pat[pos] === '?';
      if (lazy) pos++;
      if (pos < pat.length && isQuantAt(pos)) fail('Invalid regular expression: nothing to repeat');
      return { k: 'rep', body: node, min, max, greedy: lazy === ungreedy };
    };
    const parseAtom = () => {
      const ch = pat[pos];
      if (ch === '*' || ch === '+' || ch === '?' || ch === ')') fail('Unexpected regex token: ' + ch);
      if (ch === '(') {
        pos++;
        const sCi = ci, sMl = ml, sDa = dotAll, sUg = ungreedy;
        let cap;
        if (pat[pos] !== '?') cap = ++groups;
        else {
          pos++;
          if (pat[pos] === '=' || pat[pos] === '!' || (pat[pos] === '<' && (pat[pos + 1] === '=' || pat[pos + 1] === '!'))) {
            fail('RE2 does not support lookaround');
          }
          if (pat[pos] === ':') pos++;
          else if (pat[pos] === '<' || (pat[pos] === 'P' && pat[pos + 1] === '<')) {
            const ns = pat.indexOf('<', pos) + 1;
            const ne = pat.indexOf('>', ns);
            if (ne === -1) fail('Unclosed group name');
            const gname = pat.slice(ns, ne);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(gname)) fail('Invalid group specifier name: ' + gname);
            if (Object.hasOwn(named, gname)) fail('Duplicate group specifier name: ' + gname);
            cap = ++groups;
            named[gname] = cap;
            pos = ne + 1;
          } else {
            const fm = /^([imsU-]+)/.exec(pat.slice(pos));
            if (!fm) fail('Unsupported group syntax');
            applyFlags(fm[1]);
            pos += fm[0].length;
            if (pat[pos] === ')') { pos++; return { k: 'empty', noQ: true }; }
            if (pat[pos] === ':') pos++;
            else fail('Invalid inline flag group');
          }
        }
        const inner = parseAlt();
        if (pat[pos] !== ')') fail('Unclosed regex group');
        pos++;
        ci = sCi; ml = sMl; dotAll = sDa; ungreedy = sUg;
        return cap === undefined ? inner : { k: 'seq', items: [inner], cap };
      }
      if (ch === '[') {
        const [fn, nextPos] = re2ClassTest(pat, pos, ci);
        pos = nextPos;
        return { k: 'ch', fn };
      }
      if (ch === '^') { pos++; const m = ml; return { k: 'as', fn: (s, p) => p === 0 || (m && p > 0 && s[p - 1] === '\\n') }; }
      if (ch === '$') { pos++; const m = ml; return { k: 'as', fn: (s, p) => p === s.length || (m && p < s.length && s[p] === '\\n') }; }
      if (ch === '.') { pos++; const da = dotAll; return { k: 'ch', fn: (c) => da || c !== '\\n' }; }
      if (ch === '\\\\') {
        const esc = pat[pos + 1];
        if (esc === undefined) fail('Trailing backslash in regex');
        const oct = re2Octal(pat, pos + 1, false);
        if (oct) {
          pos = oct[1];
          const f = ci;
          return { k: 'ch', fn: (c) => re2FoldEq(c, oct[0], f) };
        }
        if (esc >= '1' && esc <= '9') fail('RE2 does not support backreferences');
        if (esc === 'b') { pos += 2; return { k: 'as', fn: (s, p) => re2Word(s[p - 1]) !== re2Word(s[p]) }; }
        if (esc === 'B') { pos += 2; return { k: 'as', fn: (s, p) => re2Word(s[p - 1]) === re2Word(s[p]) }; }
        if (esc === 'A') { pos += 2; return { k: 'as', fn: (_s, p) => p === 0 }; }
        if (esc === 'z') { pos += 2; return { k: 'as', fn: (s, p) => p === s.length }; }
        if (esc === 'd' || esc === 'D' || esc === 'w' || esc === 'W' || esc === 's' || esc === 'S') {
          pos += 2;
          return { k: 'ch', fn: re2ShortClass(esc) };
        }
        if ((esc === 'p' || esc === 'P') && pat[pos + 2] === '{') {
          const end = pat.indexOf('}', pos + 3);
          if (end === -1) fail('Unclosed Unicode property class');
          const spec = pat.slice(pos + 3, end);
          pos = end + 1;
          return { k: 'ch', fn: re2UnicodeProp(spec, esc === 'P', ci) };
        }
        if ((esc === 'p' || esc === 'P') && /[A-Za-z]/.test(pat[pos + 2] || '')) {
          const spec = pat[pos + 2];
          if (!RE2_SHORT_CATS.has(spec)) fail('Invalid Unicode property class: \\\\' + esc + spec);
          pos += 3;
          return { k: 'ch', fn: re2UnicodeProp(spec, esc === 'P', ci) };
        }
        const [lit, nextPos] = re2EscapeChar(pat, pos + 1, false);
        pos = nextPos;
        const f = ci;
        return { k: 'ch', fn: (c) => re2FoldEq(c, lit, f) };
      }
      const cp = pat.codePointAt(pos);
      const lit = String.fromCodePoint(cp);
      pos += lit.length;
      const f = ci;
      return { k: 'ch', fn: (c) => re2FoldEq(c, lit, f) };
    };
    const ast = parseAlt();
    if (pos !== pat.length) fail('Unexpected trailing ) in regex');
    return { ast, groups, named };
  }
  function re2Build(ast) {
    const states = [{ k: 'acc' }];
    const add = (st) => {
      if (states.length >= RE2_MAX_STATES) fail('Regex exceeds state limit');
      if ((states.length & 15) === 0) tick();
      const id = states.length;
      states.push(st);
      return id;
    };
    const emit = (node, out) => {
      if (node.k === 'empty') return out;
      if (node.k === 'ch') return add({ k: 'ch', fn: node.fn, out });
      if (node.k === 'as') return add({ k: 'as', fn: node.fn, out });
      if (node.k === 'seq') {
        let cur = node.cap === undefined ? out : add({ k: 'save', slot: 2 * node.cap + 1, out });
        for (let i = node.items.length - 1; i >= 0; i--) cur = emit(node.items[i], cur);
        return node.cap === undefined ? cur : add({ k: 'save', slot: 2 * node.cap, out: cur });
      }
      if (node.k === 'alt') return add({ k: 'split', a: emit(node.a, out), b: emit(node.b, out) });
      const mk = (more, exit) => node.greedy === false ? { k: 'split', a: exit, b: more } : { k: 'split', a: more, b: exit };
      let tail = out;
      if (node.max === Infinity) {
        const sp = add(mk(0, out));
        states[sp] = mk(emit(node.body, sp), out);
        tail = sp;
      } else {
        for (let k = node.min; k < node.max; k++) tail = add(mk(emit(node.body, tail), tail));
      }
      for (let k = node.min - 1; k >= 0; k--) tail = emit(node.body, tail);
      return tail;
    };
    return { states, start: emit(ast, 0) };
  }
  function re2Matches(subject, pattern) {
    text(subject); text(pattern);
    const { ast } = re2Parse(pattern);
    const nfa = re2Build(ast);
    const chars = Array.from(subject);
    const marks = new Uint32Array(nfa.states.length);
    let mark = 0, steps = 0;
    const close = (seeds, pos) => {
      mark++;
      const stack = [...seeds], out = [];
      while (stack.length) {
        if ((++steps & 7) === 0) tick();
        const id = stack.pop();
        if (marks[id] === mark) continue;
        marks[id] = mark;
        const st = nfa.states[id];
        if (st.k === 'split') stack.push(st.b, st.a);
        else if (st.k === 'save') stack.push(st.out);
        else if (st.k === 'as') { if (st.fn(chars, pos)) stack.push(st.out); }
        else out.push(id);
      }
      return out;
    };
    let cur = close([nfa.start], 0);
    for (let i = 0; i < chars.length && cur.length; i++) {
      tick();
      const next = [];
      for (const id of cur) {
        if ((++steps & 7) === 0) tick();
        const st = nfa.states[id];
        if (st.k === 'ch' && st.fn(chars[i])) next.push(st.out);
      }
      cur = close(next, i + 1);
    }
    return cur.includes(0);
  }
  function re2Find(chars, nfa, groupCount, startPos) {
    const slotsLen = 2 * (groupCount + 1);
    let steps = 0;
    const addThread = (list, seen, id, slots, pos) => {
      if ((++steps & 7) === 0) tick();
      if (seen.has(id)) return;
      seen.add(id);
      const st = nfa.states[id];
      if (st.k === 'split') {
        addThread(list, seen, st.a, slots, pos);
        addThread(list, seen, st.b, slots, pos);
      } else if (st.k === 'save') {
        tick(1 + (slotsLen >> 3));
        const next = slots.slice();
        next[st.slot] = pos;
        addThread(list, seen, st.out, next, pos);
      } else if (st.k === 'as') {
        if (st.fn(chars, pos)) addThread(list, seen, st.out, slots, pos);
      } else {
        list.push({ id, slots });
      }
    };
    let cur = [], best = null;
    for (let pos = startPos; pos <= chars.length; pos++) {
      tick();
      if (best === null) {
        const init = new Array(slotsLen).fill(-1);
        init[0] = pos;
        const seenStart = new Set(cur.map((t) => t.id));
        addThread(cur, seenStart, nfa.start, init, pos);
      }
      const next = [], seenNext = new Set();
      for (const th of cur) {
        if ((++steps & 7) === 0) tick();
        const st = nfa.states[th.id];
        if (st.k === 'acc') {
          const done = th.slots.slice();
          done[1] = pos;
          best = done;
          break;
        }
        if (pos < chars.length && st.k === 'ch' && st.fn(chars[pos])) {
          addThread(next, seenNext, st.out, th.slots, pos + 1);
        }
      }
      cur = next;
      if (cur.length === 0 && best !== null) break;
    }
    return best;
  }
  function re2Subject(subject) {
    const chars = Array.from(subject);
    const offsets = [];
    const charAt = new Int32Array(subject.length + 1).fill(-1);
    let off = 0;
    for (let i = 0; i < chars.length; i++) {
      offsets.push(off);
      charAt[off] = i;
      off += chars[i].length;
    }
    offsets.push(off);
    charAt[off] = chars.length;
    return {
      find(nfa, groups, from) {
        const idx = charAt[from];
        if (idx >= 0) {
          const m = re2Find(chars, nfa, groups, idx);
          return m ? m.map((p) => p < 0 ? -1 : offsets[p]) : null;
        }
        const nextIdx = charAt[from + 1];
        const subChars = [subject[from - 1], subject[from], ...chars.slice(nextIdx)];
        const m = re2Find(subChars, nfa, groups, 1);
        if (!m) return null;
        return m.map((p) => p < 0 ? -1 : p === 1 ? from : offsets[nextIdx + p - 2]);
      },
    };
  }
  function re2Split(subject, pattern) {
    text(subject); text(pattern);
    const { ast, groups } = re2Parse(pattern);
    const nfa = re2Build(ast);
    const sub = re2Subject(subject);
    if (subject.length === 0) return sub.find(nfa, groups, 0) === null ? [''] : [];
    const pieces = [];
    let pieceStart = 0, from = 0;
    while (from < subject.length) {
      const m = sub.find(nfa, groups, from);
      if (!m || m[0] >= subject.length) break;
      if (m[1] === pieceStart) { from = m[0] + 1; continue; }
      pieces.push(subject.slice(pieceStart, m[0]));
      pieceStart = m[1];
      from = pieceStart;
    }
    pieces.push(subject.slice(pieceStart));
    while (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop();
    return pieces;
  }
  function re2Replace(subject, pattern, replacement) {
    text(subject); text(pattern); text(replacement);
    const { ast, groups, named } = re2Parse(pattern);
    const nfa = re2Build(ast);
    const sub = re2Subject(subject);
    let out = '', copied = 0, from = 0;
    while (from <= subject.length) {
      const m = sub.find(nfa, groups, from);
      if (!m) break;
      out += subject.slice(copied, m[0]);
      const gs = [];
      for (let g = 0; g <= groups; g++) {
        const a = m[2 * g], b = m[2 * g + 1];
        gs.push(a >= 0 && b >= a ? subject.slice(a, b) : '');
      }
      for (let i = 0; i < replacement.length; ) {
        const c = replacement[i];
        if (c === '\\\\') {
          if (i + 1 >= replacement.length) fail('Invalid replace escape');
          out += replacement[i + 1]; i += 2; continue;
        }
        if (c !== '$') { out += c; i++; continue; }
        if (replacement[i + 1] === '{') {
          const end = replacement.indexOf('}', i + 2);
          if (end === -1) fail('Unclosed group reference');
          const name = replacement.slice(i + 2, end);
          if (!Object.hasOwn(named, name)) fail('Unknown group: ' + name);
          out += gs[named[name]] || ''; i = end + 1; continue;
        }
        const d = replacement[i + 1];
        if (d === undefined || d < '0' || d > '9') fail('Illegal group reference');
        let num = Number(d), end = i + 2;
        while (end < replacement.length && replacement[end] >= '0' && replacement[end] <= '9') {
          const nextNum = num * 10 + Number(replacement[end]);
          if (nextNum > groups) break;
          num = nextNum; end++;
        }
        if (num > groups) fail('Group index out of range');
        out += gs[num] || ''; i = end;
      }
      copied = m[1];
      from = m[1] === m[0] ? m[1] + 1 : m[1];
    }
    return text(out + subject.slice(copied));
  }
`;
