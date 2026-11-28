// Embedded zero-dependency runtime for generated standalone ES modules.
// Runs identically in browsers, edge workers, Node, and Bun with Rules-v2-faithful values,
// own-data/prototype hardening, and non-absorbable resource/tick limits.
import { boundedRe2Runtime } from './runtime-re2.js';
import { boundedTypesRuntime } from './runtime-types.js';

export const boundedRuntime = `function runtime(budget = 1000000) {
  let remaining = budget;
  class RuleError extends Error {}
  class ResourceLimitError extends Error {}
  function fail(message) {
    throw new RuleError(message);
  }
  function limit(message) {
    throw new ResourceLimitError(message);
  }
  function read(value) {
    if (value instanceof RuleError) throw value;
    return value;
  }
  function capture(fn, ...values) {
    try {
      for (const value of values) read(value);
      return fn(...values);
    } catch (error) {
      if (error instanceof RuleError) return error;
      throw error;
    }
  }
  function tick(amount = 1) {
    if ((remaining -= amount) < 0) limit('Evaluation budget exceeded');
  }
  function bool(x) {
    if (typeof x !== 'boolean') fail('Expected a boolean');
    return x;
  }
  function list(x) {
    if (!Array.isArray(x)) fail('Expected a list');
    if (x.length > 4096) limit('List bound exceeded');
    return x;
  }
  function text(x) {
    if (typeof x !== 'string') fail('Expected a string');
    if (x.length > 4096) limit('String bound exceeded');
    return x;
  }
  function logical(determining, left, right) {
    let first;
    try {
      first = bool(read(left()));
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      let second;
      try {
        second = bool(read(right()));
      } catch (err2) {
        if (!(err2 instanceof RuleError)) throw err2;
        throw error;
      }
      if (second === determining) return second;
      throw error;
    }
    return first === determining ? first : bool(read(right()));
  }
${boundedTypesRuntime}
${boundedRe2Runtime}
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function checkKey(key) {
    if (FORBIDDEN_KEYS.has(key)) fail('Missing own data value: forbidden key ' + key);
    return key;
  }
  function ownData(obj, key) {
    if (typeof key === 'string') checkKey(key);
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !('value' in desc)) fail('Missing own data value');
    return desc.value;
  }
  function member(xs, key) {
    if (!isMap(xs)) fail('Expected a record for member access');
    return ownData(xs, key);
  }
  function index(xs, i) {
    if (typeof xs === 'string' || Array.isArray(xs)) {
      const idx = intIndex(i);
      if (idx < 0 || idx >= xs.length) fail('Index outside collection');
      return typeof xs === 'string' ? text(xs)[idx] : ownData(xs, idx);
    }
    if (!isMap(xs) || typeof i !== 'string') fail('Expected a record key');
    return ownData(xs, i);
  }
  function indexAt(i, xs) {
    return index(xs, i);
  }
  function slice(xs, start, end) {
    const from = requireInt(start);
    const to = requireInt(end);
    if (typeof xs !== 'string' && !Array.isArray(xs)) fail('Slice not supported on this type');
    const len = BigInt(xs.length);
    if (from < 0n || from >= len) fail('Index out of bound error');
    const endIdx = to - 1n;
    if (endIdx < 0n || endIdx >= len) fail('Index out of bound error');
    if (from > to) fail('Illegal range error');
    tick(Number(to - from));
    return xs.slice(Number(from), Number(to));
  }
  function inOp(coll, el) {
    if (coll === null || coll === undefined) fail('Null value error.');
    if (Array.isArray(coll)) {
      tick(coll.length);
      return coll.some((m) => listEq(m, el));
    }
    if (coll instanceof SetVal) {
      tick(coll.items.length);
      return coll.has(el);
    }
    if (isMap(coll)) {
      if (typeof el !== 'string') fail('Expected a string key');
      return Object.hasOwn(coll, el);
    }
    fail('Function not found error: Name: [in].');
  }
  function isOp(v, t) {
    switch (t) {
      case 'string': return typeof v === 'string';
      case 'int': return isInt(v);
      case 'float': return isFloat(v);
      case 'number': return isNum(v);
      case 'bool': return typeof v === 'boolean';
      case 'null': return v === null;
      case 'list': return Array.isArray(v);
      case 'set': return v instanceof SetVal;
      case 'map': return isMap(v);
      case 'timestamp': return v instanceof TimestampVal;
      case 'duration': return v instanceof DurationVal;
      case 'bytes': return v instanceof BytesVal;
      default: return false;
    }
  }
  // Copy plain input data into the evaluation. Bound work before traversing it.
  let inputNodes = 0;
  function data(value, depth = 0) {
    if (++inputNodes > 16384 || depth > 32) limit('Input depth or node bound exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : new FloatVal(value);
    }
    if (typeof value === 'bigint') return checkInt64(value);
    if (typeof value === 'string') return text(value);
    if (value instanceof Uint8Array) {
      if (Object.getPrototypeOf(value) !== Uint8Array.prototype) fail('Expected plain bytes data');
      if (value.length > 65536) limit('Bytes bound exceeded');
      if (Object.getOwnPropertySymbols(value).length) fail('Expected plain data without symbols');
      for (const k of Object.getOwnPropertyNames(value)) {
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (d && !('value' in d)) fail('Missing own data value');
      }
      return new BytesVal(Uint8Array.prototype.slice.call(value));
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('Expected plain list data');
      list(value);
      if (Object.getOwnPropertySymbols(value).length) fail('Expected plain data without symbols');
      for (const k of Object.getOwnPropertyNames(value)) {
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (d && !('value' in d)) fail('Missing own data value');
      }
      const result = [];
      for (let i = 0; i < value.length; i++) result.push(data(ownData(value, i), depth + 1));
      return result;
    }
    if (!value || typeof value !== 'object') fail('Expected plain data');
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) fail('Expected plain record data');
    if (Object.getOwnPropertySymbols(value).length) fail('Expected plain data without symbols');
    const result = Object.create(null);
    let count = 0;
    for (const key of Object.getOwnPropertyNames(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc)) fail('Missing own data value');
      if (!desc.enumerable) continue;
      if (++count > 4096) limit('Record size bound exceeded');
      checkKey(text(key));
      Object.defineProperty(result, key, { value: data(desc.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  function exportVal(value, depth = 0, st = { n: 0 }) {
    if (++st.n > 16384 || depth > 64) limit('Output depth or node bound exceeded');
    tick();
    if (typeof value === 'bigint') return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
    if (value instanceof FloatVal) return value.v;
    if (value instanceof BytesVal) return new Uint8Array(value.d);
    if (value instanceof TimestampVal) return { __type: 'timestamp', seconds: value.s, nanos: value.n };
    if (value instanceof DurationVal) return { __type: 'duration', seconds: value.s, nanos: value.n };
    if (value instanceof SetVal) return value.items.map((v) => exportVal(v, depth + 1, st));
    if (Array.isArray(value)) return value.map((v) => exportVal(v, depth + 1, st));
    if (isMap(value)) {
      const out = {};
      for (const key of Object.keys(value)) {
        Object.defineProperty(out, key, { value: exportVal(value[key], depth + 1, st), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return value;
  }
  function makeList(xs) {
    for (const x of xs) read(x);
    if (xs.length > 4096) limit('List bound exceeded');
    return xs;
  }
  function makeRecord(pairs) {
    const obj = Object.create(null);
    const order = [];
    for (const pair of pairs) {
      const k = checkKey(text(read(pair[0])));
      const v = read(pair[1]);
      if (!Object.hasOwn(obj, k)) {
        if (order.length >= 4096) limit('Record size bound exceeded');
        order.push(k);
      }
      Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    mapOrder.set(obj, order);
    return obj;
  }
  function trimRules(s) {
    let a = 0, b = s.length;
    while (a < b && s.charCodeAt(a) <= 32) a++;
    while (b > a && s.charCodeAt(b - 1) <= 32) b--;
    return s.slice(a, b);
  }
  function method(obj, name, ...args) {
    if (obj instanceof BytesVal) {
      if (name === 'size' && args.length === 0) return obj.size();
      if (name === 'toBase64' && args.length === 0) return obj.toBase64();
      if (name === 'toHexString' && args.length === 0) return obj.toHexString();
      fail('Unknown bytes method ' + name);
    }
    if (obj instanceof TimestampVal) {
      if (args.length !== 0) fail('Timestamp method takes no arguments');
      const d = () => new Date(obj.toMillis());
      switch (name) {
        case 'seconds': return BigInt(((obj.s % 60) + 60) % 60);
        case 'nanos': return BigInt(obj.n);
        case 'toMillis': return BigInt(obj.toMillis());
        case 'year': return BigInt(d().getUTCFullYear());
        case 'month': return BigInt(d().getUTCMonth() + 1);
        case 'day': return BigInt(d().getUTCDate());
        case 'hours': return BigInt(d().getUTCHours());
        case 'minutes': return BigInt(d().getUTCMinutes());
        case 'dayOfWeek': { const wd = d().getUTCDay(); return BigInt(wd === 0 ? 7 : wd); }
        case 'dayOfYear': {
          const dt = d();
          return BigInt(Math.floor((obj.toMillis() - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 86400000) + 1);
        }
        case 'date': { const dt = d(); return tsFromYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
        case 'time': {
          const sod = ((obj.s % 86400) + 86400) % 86400;
          return durFromNanos(BigInt(sod) * BIG_NANOS_PER_SEC + BigInt(obj.n));
        }
        default: fail('Unknown timestamp method ' + name);
      }
    }
    if (obj instanceof DurationVal) {
      if (args.length !== 0) fail('Duration method takes no arguments');
      if (name === 'seconds') return BigInt(obj.s);
      if (name === 'nanos') return BigInt(obj.n);
      fail('Unknown duration method ' + name);
    }
    if (obj instanceof SetVal) {
      if (name === 'size' && args.length === 0) return BigInt(obj.items.length);
      if ((name === 'hasAll' || name === 'hasAny' || name === 'hasOnly') && args.length === 1) {
        const arr = args[0] instanceof SetVal ? args[0].items : Array.isArray(args[0]) ? args[0] : fail('Expected list or set');
        tick(obj.items.length + arr.length);
        if (name === 'hasAll') return arr.every((k) => obj.has(k));
        if (name === 'hasAny') return arr.some((k) => obj.has(k));
        return obj.items.every((item) => arr.some((k) => setEq(item, k)));
      }
      if ((name === 'difference' || name === 'union' || name === 'intersection') && args.length === 1) {
        if (!(args[0] instanceof SetVal)) fail('Expected a set');
        tick(obj.items.length + args[0].items.length);
        if (name === 'union') return new SetVal([...obj.items, ...args[0].items]);
        if (name === 'difference') return new SetVal(obj.items.filter((x) => !args[0].has(x)));
        return new SetVal(obj.items.filter((x) => args[0].has(x)));
      }
      fail('Unknown set method ' + name);
    }
    if (obj instanceof MapDiffVal) {
      if (args.length !== 0) fail('MapDiff method takes no arguments');
      if (name === 'addedKeys' || name === 'removedKeys' || name === 'changedKeys' || name === 'affectedKeys' || name === 'unchangedKeys') {
        return obj[name]();
      }
      fail('Unknown map_diff method ' + name);
    }
    if (typeof obj === 'string') {
      text(obj);
      if (name === 'size' && args.length === 0) return BigInt(obj.length);
      if (name === 'lower' && args.length === 0) return obj.replace(/[A-Z]+/g, (s) => s.toLowerCase());
      if (name === 'upper' && args.length === 0) return obj.replace(/[a-z]+/g, (s) => s.toUpperCase());
      if (name === 'trim' && args.length === 0) return trimRules(obj);
      if (name === 'toUtf8' && args.length === 0) return new BytesVal(new TextEncoder().encode(obj));
      if (name === 'matches' && args.length === 1) return re2Matches(obj, args[0]);
      if (name === 'split' && args.length === 1) return re2Split(obj, args[0]);
      if (name === 'replace' && args.length === 2) return re2Replace(obj, args[0], args[1]);
      fail('Unknown string method ' + name);
    }
    if (Array.isArray(obj)) {
      list(obj);
      if (name === 'size' && args.length === 0) return BigInt(obj.length);
      if (name === 'toSet' && args.length === 0) return new SetVal(obj);
      if (name === 'concat' && args.length === 1) {
        const other = list(args[0]);
        tick(obj.length + other.length);
        if (obj.length + other.length > 4096) limit('List result bound exceeded');
        return obj.concat(other);
      }
      if (name === 'join' && args.length === 1) {
        const sep = text(args[0]);
        tick(obj.length);
        const parts = obj.map((el) => conv('string', el));
        return text(parts.join(sep));
      }
      if (name === 'removeAll' && args.length === 1) {
        const rem = list(args[0]);
        tick(obj.length * Math.max(1, rem.length));
        return obj.filter((v) => !rem.some((r) => listEq(v, r)));
      }
      if ((name === 'hasAll' || name === 'hasAny' || name === 'hasOnly') && args.length === 1) {
        const cand = list(args[0]);
        tick(obj.length * Math.max(1, cand.length));
        if (name === 'hasAll') return cand.every((c) => obj.some((m) => listEq(m, c)));
        if (name === 'hasAny') return cand.some((c) => obj.some((m) => listEq(m, c)));
        return obj.every((m) => cand.some((c) => listEq(m, c)));
      }
      fail('Unknown list method ' + name);
    }
    if (isMap(obj)) {
      if (name === 'size' && args.length === 0) return BigInt(Object.keys(obj).length);
      if (name === 'keys' && args.length === 0) {
        const ks = Object.keys(obj); tick(ks.length); return ks.sort(cmpCodePoints);
      }
      if (name === 'values' && args.length === 0) {
        const order = mapOrder.get(obj) || Object.keys(obj);
        tick(order.length);
        return order.map((k) => obj[k]);
      }
      if (name === 'diff' && args.length === 1) {
        if (!isMap(args[0])) fail('diff() requires a map');
        return new MapDiffVal(args[0], obj);
      }
      if (name === 'get' && args.length === 2) {
        const [keyArg, def] = args;
        if (Array.isArray(keyArg)) {
          for (const seg of keyArg) if (typeof seg !== 'string') fail('Expected string path segment');
          let cur = obj;
          for (const seg of keyArg) {
            if (!isMap(cur) || !Object.hasOwn(cur, seg)) return def;
            cur = cur[seg];
          }
          return cur;
        }
        if (typeof keyArg !== 'string') fail('Expected string key');
        return Object.hasOwn(obj, keyArg) ? obj[keyArg] : def;
      }
      fail('Unknown map method ' + name);
    }
    fail('Unknown method ' + name);
  }
  function binary(op, left, right) {
    if (op === '==') return eq(left, right);
    if (op === '!=') return !eq(left, right);
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (isInt(left) && isInt(right)) {
        return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
      }
      if (isNum(left) && isNum(right)) {
        const a = asDouble(left), b = asDouble(right);
        return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
      }
      if (typeof left === 'string' && typeof right === 'string') {
        return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
      }
      if (
        (left instanceof BytesVal && right instanceof BytesVal) ||
        (left instanceof TimestampVal && right instanceof TimestampVal) ||
        (left instanceof DurationVal && right instanceof DurationVal)
      ) {
        const c = left.cmp(right);
        return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      }
      fail('Operator ' + op + ' is not defined for operand types');
    }
    if (op === '+') {
      if (typeof left === 'string' && typeof right === 'string') return text(left + right);
      if (isInt(left) && isInt(right)) return intOp('+', left, right);
      if (isNum(left) && isNum(right)) return floatOp('+', asDouble(left), asDouble(right));
      if (left instanceof TimestampVal && right instanceof DurationVal) return new TimestampVal(left.s + right.s, left.n + right.n);
      if (left instanceof DurationVal && right instanceof TimestampVal) return new TimestampVal(right.s + left.s, right.n + left.n);
      if (left instanceof DurationVal && right instanceof DurationVal) return new DurationVal(left.s + right.s, left.n + right.n);
      fail('Operator + is not defined for operand types');
    }
    if (op === '-') {
      if (isInt(left) && isInt(right)) return intOp('-', left, right);
      if (isNum(left) && isNum(right)) return floatOp('-', asDouble(left), asDouble(right));
      if (left instanceof TimestampVal && right instanceof TimestampVal) return new DurationVal(left.s - right.s, left.n - right.n);
      if (left instanceof TimestampVal && right instanceof DurationVal) return new TimestampVal(left.s - right.s, left.n - right.n);
      if (left instanceof DurationVal && right instanceof DurationVal) return new DurationVal(left.s - right.s, left.n - right.n);
      fail('Operator - is not defined for operand types');
    }
    if (op === '*' || op === '/' || op === '%') {
      if (isInt(left) && isInt(right)) return intOp(op, left, right);
      if (isNum(left) && isNum(right)) return floatOp(op, asDouble(left), asDouble(right));
      fail('Operator ' + op + ' is not defined for operand types');
    }
    fail('Unknown operation ' + op);
  }
  function neg(x) {
    if (isInt(x)) return checkInt64(-x);
    if (isFloat(x)) return new FloatVal(-x.v);
    if (x instanceof DurationVal) return x.negated();
    fail('Unsupported unary minus');
  }
  function size(x) {
    if (typeof x === 'string') return BigInt(text(x).length);
    if (Array.isArray(x)) return BigInt(list(x).length);
    if (isMap(x)) return BigInt(Object.keys(x).length);
    if (x instanceof SetVal) return BigInt(x.items.length);
    if (x instanceof BytesVal) return x.size();
    fail('Expected a sized collection');
  }
  function replaceAt(xs, i, v) {
    list(xs);
    const idx = intIndex(i);
    if (idx < 0 || idx >= xs.length) fail('Index outside collection');
    tick(xs.length);
    const copy = [...xs];
    copy[idx] = v;
    return copy;
  }
  function range(n) {
    const k = intIndex(n);
    if (k < 0 || k > 256) limit('Range bound exceeded');
    tick(k);
    return Array.from({ length: k }, (_, i) => BigInt(i));
  }
  function locate(xs, v) {
    if (typeof xs === 'string') {
      text(xs); tick(xs.length);
      return BigInt(xs.indexOf(text(v)));
    }
    list(xs); tick(xs.length);
    for (let i = 0; i < xs.length; i++) if (listEq(xs[i], v)) return BigInt(i);
    return -1n;
  }
  function sorted(xs) {
    list(xs); tick(xs.length * Math.max(1, Math.ceil(Math.log2(xs.length + 1))));
    if (!xs.every((v) => typeof v === 'string')) fail('Expected strings');
    return [...xs].sort();
  }
  function chain(xs, ys) {
    list(xs); list(ys);
    tick(xs.length + ys.length);
    if (xs.length + ys.length > 4096) limit('List result bound exceeded');
    return xs.concat(ys);
  }
  function omit(s, flag) { text(s); text(flag); tick(s.length); return s.replace(flag, ''); }
  function kind(x) {
    if (Array.isArray(x)) return 'list';
    if (x === null) return 'null';
    if (isNum(x)) return 'number';
    if (x instanceof BytesVal) return 'bytes';
    if (x instanceof TimestampVal) return 'timestamp';
    if (x instanceof DurationVal) return 'duration';
    if (x instanceof SetVal) return 'set';
    if (x instanceof MapDiffVal) return 'map_diff';
    return typeof x;
  }
  function traverse(op, xs, pred, bound) {
    list(xs);
    if (xs.length > bound) limit('Traversal bound exceeded');
    const result = [];
    let firstError;
    let count = 0;
    for (let i = 0; i < xs.length; i++) {
      tick();
      const value = ownData(xs, i);
      let answer;
      try {
        answer = pred(value);
      } catch (err) {
        if (err instanceof RuleError) answer = err;
        else throw err;
      }
      if (op === 'any' || op === 'all' || op === 'select' || op === 'count') answer = capture(bool, answer);
      if (op === 'flatMap') answer = capture(list, answer);
      if (answer instanceof RuleError) {
        firstError ??= answer;
        continue;
      }
      if (op === 'any') { if (answer) return true; }
      else if (op === 'all') { if (!answer) return false; }
      else if (op === 'count') { if (answer) count++; }
      else if (op === 'select') { if (answer) result.push(value); }
      else if (op === 'map') { result.push(answer); }
      else {
        const part = list(answer);
        if (part.length + result.length > 4096) limit('List result bound exceeded');
        tick(part.length);
        result.push(...part);
      }
    }
    if (firstError) return firstError;
    if (op === 'any') return false;
    if (op === 'all') return true;
    if (op === 'count') return BigInt(count);
    return result;
  }
  function fold(xs, init, step, bound) {
    let err;
    if (xs instanceof RuleError) { err = xs; }
    else {
      try { list(xs); if (xs.length > bound) limit('Traversal bound exceeded'); }
      catch (e) { if (e instanceof RuleError) err = e; else throw e; }
    }
    if (err) return err;
    let acc = read(init);
    for (let i = 0; i < xs.length; i++) {
      tick();
      const value = ownData(xs, i);
      acc = read(step(acc, value));
    }
    return acc;
  }
  function append(xs, ys, bound) {
    let err;
    let lx, ly;
    if (xs instanceof RuleError) err = xs;
    else {
      try { lx = list(xs); if (lx.length > bound) limit('Append exceeds declared limit ' + bound); }
      catch (e) { if (e instanceof RuleError) err = e; else throw e; }
    }
    if (ys instanceof RuleError) err ??= ys;
    else {
      try { ly = list(ys); }
      catch (e) { if (e instanceof RuleError) err ??= e; else throw e; }
    }
    if (err) return err;
    if (lx.length + ly.length > bound) limit('Append exceeds declared limit ' + bound);
    tick(lx.length + ly.length);
    return lx.concat(ly);
  }
  function loopList(xs, bound) {
    list(xs);
    if (xs.length > bound) limit('Loop input length ' + xs.length + ' exceeds declared bound ' + bound);
    return xs;
  }
  const operations = {
    logical, binary, neg, not: (x) => !bool(x),
    choose: (cond, yes, no) => bool(cond) ? yes() : no(),
    makeList, makeRecord, bool, member, index, indexAt, slice, inOp, isOp,
    method, ns, conv, flt: (n) => new FloatVal(n), bytes: (arr) => new BytesVal(new Uint8Array(arr)),
    size, replaceAt, range, locate, sorted, chain, omit, eq, traverse, loopList, kind,
    fail: (msg) => { throw new Error(text(msg)); },
    abs: (n) => isInt(n) ? (n < 0n && n !== INT64_MIN ? -n : n) : isFloat(n) ? new FloatVal(Math.abs(n.v)) : fail('Expected a number'),
    sign: (n) => isInt(n) ? (n < 0n ? -1n : n > 0n ? 1n : 0n) : isFloat(n) ? new FloatVal(Math.sign(n.v)) : fail('Expected a number'),
  };
  const api = {
    tick, used: () => budget - remaining, data, read, exportVal,
    fold: (xs, init, step, bound) => {
      try { return fold(xs, init, step, bound); }
      catch (error) { if (error instanceof RuleError) return error; throw error; }
    },
    append: (xs, ys, bound) => {
      try { return append(xs, ys, bound); }
      catch (error) { if (error instanceof RuleError) return error; throw error; }
    },
  };
  for (const name of Object.keys(operations)) {
    api[name] = (...args) => capture(operations[name], ...args);
  }
  return api;
}
`;
