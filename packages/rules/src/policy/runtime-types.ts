// Embedded Rules-v2-faithful value types, int64/float64 arithmetic, 3-tier structural equality,
// timestamps, durations, bytes, sets, map diffs, math namespace, and conversions.
// Runs in zero-dependency standalone ES modules in browsers, edge workers, and Node/Bun.
export const boundedTypesRuntime = `  const INT64_MIN = -(1n << 63n);
  const INT64_MAX = (1n << 63n) - 1n;
  const MAX_SAFE = 9007199254740991n;
  const MIN_SAFE = -9007199254740991n;
  const NANOS_PER_SEC = 1000000000;
  const BIG_NANOS_PER_SEC = 1000000000n;
  const MIN_TS_SEC = -62135596800;
  const MAX_TS_SEC = 253402300799;
  const MIN_TS_MS = -62135596800000n;
  const MAX_TS_MS = 253402300799999n;
  const MAX_DUR_SEC = 315576000000;
  const BIG_MAX_DUR_SEC = 315576000000n;
  const HEX = '0123456789ABCDEF';
  const DUR_UNITS = {
    w: 604800000000000n, d: 86400000000000n, h: 3600000000000n,
    m: 60000000000n, s: 1000000000n, ms: 1000000n, ns: 1n,
  };
  const mapOrder = new WeakMap();

  class FloatVal { constructor(v) { this.v = v; } }
  class BytesVal {
    constructor(d) { this.d = d; }
    size() { return BigInt(this.d.length); }
    toHexString() {
      let out = '';
      for (let i = 0; i < this.d.length; i++) {
        const b = this.d[i];
        out += HEX[b >>> 4] + HEX[b & 15];
      }
      return out;
    }
    toBase64() {
      let bin = '';
      for (let i = 0; i < this.d.length; i++) bin += String.fromCharCode(this.d[i]);
      return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_');
    }
    equals(other) {
      if (!(other instanceof BytesVal) || this.d.length !== other.d.length) return false;
      for (let i = 0; i < this.d.length; i++) if (this.d[i] !== other.d[i]) return false;
      return true;
    }
    cmp(other) {
      const len = Math.min(this.d.length, other.d.length);
      for (let i = 0; i < len; i++) if (this.d[i] !== other.d[i]) return this.d[i] < other.d[i] ? -1 : 1;
      return this.d.length === other.d.length ? 0 : this.d.length < other.d.length ? -1 : 1;
    }
  }
  class DurationVal {
    constructor(sec, nanos) {
      let s = sec + Math.trunc(nanos / NANOS_PER_SEC);
      let n = nanos % NANOS_PER_SEC;
      if (s > 0 && n < 0) { s -= 1; n += NANOS_PER_SEC; }
      else if (s < 0 && n > 0) { s += 1; n -= NANOS_PER_SEC; }
      if (!Number.isFinite(s) || Math.abs(s) > MAX_DUR_SEC) fail('Duration is not valid');
      this.s = s === 0 ? 0 : s;
      this.n = n === 0 ? 0 : n;
    }
    equals(o) { return o instanceof DurationVal && this.s === o.s && this.n === o.n; }
    cmp(o) { return this.s !== o.s ? this.s - o.s : this.n - o.n; }
    negated() { return new DurationVal(-this.s, -this.n); }
  }
  function durFromNanos(total) {
    const s = total / BIG_NANOS_PER_SEC;
    if (s > BIG_MAX_DUR_SEC || s < -BIG_MAX_DUR_SEC) fail('Duration is not valid');
    return new DurationVal(Number(s), Number(total % BIG_NANOS_PER_SEC));
  }
  class TimestampVal {
    constructor(sec, nanos) {
      const carry = Math.floor(nanos / NANOS_PER_SEC);
      const s = sec + carry;
      const n = nanos - carry * NANOS_PER_SEC;
      if (!Number.isFinite(s) || s < MIN_TS_SEC || s > MAX_TS_SEC) fail('Timestamp is not valid');
      this.s = s === 0 ? 0 : s;
      this.n = n === 0 ? 0 : n;
    }
    toMillis() { return this.s * 1000 + Math.floor(this.n / 1000000); }
    equals(o) { return o instanceof TimestampVal && this.s === o.s && this.n === o.n; }
    cmp(o) { return this.s !== o.s ? this.s - o.s : this.n - o.n; }
  }
  function tsFromMillis(ms) {
    if (!Number.isFinite(ms)) fail('Timestamp is not valid');
    const s = Math.floor(ms / 1000);
    return new TimestampVal(s, (ms - s * 1000) * 1000000);
  }
  function tsFromYMD(y, m, d) {
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) fail('Date is not valid');
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) fail('Date is not valid');
    return tsFromMillis(dt.getTime());
  }
  class SetVal {
    constructor(items) {
      this.items = [];
      for (const item of items) {
        tick();
        if (!this.items.some((e) => setEq(e, item))) this.items.push(item);
      }
    }
    equals(o) {
      if (!(o instanceof SetVal) || o.items.length !== this.items.length) return false;
      return this.items.every((item) => o.items.some((cand) => setEq(item, cand)));
    }
    has(el) { return this.items.some((item) => setEq(item, el)); }
  }
  class MapDiffVal {
    constructor(before, after) { this.before = before; this.after = after; }
    addedKeys() { return new SetVal(Object.keys(this.after).filter((k) => !Object.hasOwn(this.before, k))); }
    removedKeys() { return new SetVal(Object.keys(this.before).filter((k) => !Object.hasOwn(this.after, k))); }
    changedKeys() {
      return new SetVal(Object.keys(this.after).filter((k) => Object.hasOwn(this.before, k) && !setEq(this.before[k], this.after[k])));
    }
    affectedKeys() {
      const keys = new Set([...Object.keys(this.before), ...Object.keys(this.after)]);
      return new SetVal([...keys].filter((k) => !Object.hasOwn(this.before, k) || !Object.hasOwn(this.after, k) || !setEq(this.before[k], this.after[k])));
    }
    unchangedKeys() {
      return new SetVal(Object.keys(this.before).filter((k) => Object.hasOwn(this.after, k) && setEq(this.before[k], this.after[k])));
    }
  }

  function isInt(x) { return typeof x === 'bigint'; }
  function isFloat(x) { return x instanceof FloatVal; }
  function isNum(x) { return typeof x === 'bigint' || x instanceof FloatVal; }
  function asDouble(x) { return x instanceof FloatVal ? x.v : typeof x === 'bigint' ? Number(x) : undefined; }
  function isWrapper(x) {
    return x instanceof FloatVal || x instanceof BytesVal || x instanceof TimestampVal ||
      x instanceof DurationVal || x instanceof SetVal || x instanceof MapDiffVal;
  }
  function isMap(x) {
    if (x === null || typeof x !== 'object' || Array.isArray(x) || isWrapper(x) || x instanceof Error) return false;
    const proto = Object.getPrototypeOf(x);
    return proto === null || proto === Object.prototype;
  }
  function checkInt64(n) {
    if (n < INT64_MIN || n > INT64_MAX) fail('Integer value is out of range');
    return n;
  }
  function requireInt(x) {
    if (typeof x !== 'bigint') fail('Expected an integer');
    return checkInt64(x);
  }
  function intIndex(x) {
    const n = requireInt(x);
    if (n < MIN_SAFE || n > MAX_SAFE) fail('Index outside collection');
    return Number(n);
  }
  function intOp(op, a, b) {
    switch (op) {
      case '+': return checkInt64(a + b);
      case '-': return checkInt64(a - b);
      case '*': return checkInt64(a * b);
      case '/':
        if (b === 0n) fail('Divide by zero error.');
        if (a === INT64_MIN && b === -1n) return INT64_MIN;
        return a / b;
      case '%':
        if (b === 0n) fail('Divide by zero error.');
        return a % b;
      default: fail('Unknown integer op');
    }
  }
  function floatOp(op, a, b) {
    switch (op) {
      case '+': return new FloatVal(a + b);
      case '-': return new FloatVal(a - b);
      case '*': return new FloatVal(a * b);
      case '/': return new FloatVal(a / b);
      case '%': return new FloatVal(a % b);
      default: fail('Unknown float op');
    }
  }
  function saturateInt(v, fn) {
    if (Number.isNaN(v)) return 0n;
    if (v <= -(2 ** 63)) return INT64_MIN;
    if (v >= 2 ** 63) return INT64_MAX;
    return BigInt(fn(v));
  }
  function formatFloat(value) {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
    const mag = Math.abs(value);
    if (mag >= 1e-3 && mag < 1e7) {
      const t = String(value);
      return t.includes('.') ? t : t + '.0';
    }
    const s = value.toExponential();
    const chosen = s.includes('.') ? s : (Number(value.toExponential(1)) === value ? value.toExponential(1) : s);
    const [d, e] = chosen.split('e');
    return (d.includes('.') ? d : d + '.0') + 'E' + Number(e);
  }

  function numInfo(x) {
    if (typeof x === 'bigint') return { v: Number(x), i: x, f: false };
    if (x instanceof FloatVal) return { v: x.v, f: true };
    return undefined;
  }
  function sameValue(l, r) { return l.i !== undefined && r.i !== undefined ? l.i === r.i : l.v === r.v; }
  function intIsFloat(i, f) { return Number.isInteger(f) && BigInt(f) === i; }
  function sameExact(l, r) {
    if ((l.i !== undefined) === (r.i !== undefined)) return sameValue(l, r);
    return l.i !== undefined ? intIsFloat(l.i, r.v) : intIsFloat(r.i, l.v);
  }
  function valsEq(a, b, numCmp, entryCmp) {
    tick();
    const l = numInfo(a), r = numInfo(b);
    if (l || r) return l !== undefined && r !== undefined && numCmp(l, r);
    if (a instanceof BytesVal || a instanceof TimestampVal || a instanceof DurationVal || a instanceof SetVal) {
      return a.equals(b);
    }
    if (b instanceof BytesVal || b instanceof TimestampVal || b instanceof DurationVal || b instanceof SetVal) {
      return b.equals(a);
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!entryCmp(a[i], b[i])) return false;
      return true;
    }
    if (isMap(a) || isMap(b)) {
      if (!isMap(a) || !isMap(b)) return false;
      const ak = Object.keys(a);
      if (ak.length !== Object.keys(b).length) return false;
      for (const k of ak) if (!Object.hasOwn(b, k) || !entryCmp(a[k], b[k])) return false;
      return true;
    }
    return a === b;
  }
  function identical(a, b) {
    return valsEq(a, b, (l, r) => l.f === r.f && sameValue(l, r) && Object.is(l.v, r.v), identical);
  }
  function eq(a, b) { return valsEq(a, b, sameValue, identical); }
  function listEq(a, b) { return valsEq(a, b, (l, r) => l.f === r.f && sameValue(l, r), identical); }
  function setEq(a, b) {
    return valsEq(a, b, (l, r) => sameExact(l, r) || (Number.isNaN(l.v) && Number.isNaN(r.v)), setEq);
  }
  function cmpCodePoints(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.codePointAt(i) - b.codePointAt(i);
    }
    return a.length - b.length;
  }
  function conv(name, x) {
    if (name === 'int') {
      if (isInt(x)) return x;
      if (isFloat(x)) return saturateInt(x.v, Math.trunc);
      if (typeof x === 'string') {
        if (!/^[+-]?\\d+$/.test(x)) fail('Type conversion error');
        return checkInt64(BigInt(x));
      }
      fail('Unsupported int() conversion');
    }
    if (name === 'float') {
      if (isFloat(x)) return x;
      if (isInt(x)) return new FloatVal(Number(x));
      if (typeof x === 'string') {
        const t = x.replace(/^[\\x00-\\x20]+|[\\x00-\\x20]+$/g, '');
        if (/^[+-]?(?:NaN|Infinity|(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?[fFdD]?)$/.test(t)) {
          return new FloatVal(parseFloat(t.replace(/[fFdD]$/, '')));
        }
        fail('Type conversion error');
      }
      fail('Unsupported float() conversion');
    }
    if (name === 'string') {
      if (typeof x === 'string') return text(x);
      if (isFloat(x)) return formatFloat(x.v);
      if (isInt(x) || typeof x === 'boolean') return String(x);
      if (x === null) return 'null';
      fail('Unsupported string() conversion');
    }
    fail('Unknown conversion ' + name);
  }
  function ns(space, fn, ...args) {
    if (space === 'math') {
      if (args.some((a) => !isNum(a))) fail('Expected numeric argument for math.' + fn);
      const a0 = args[0];
      if (fn === 'abs') return isInt(a0) ? (a0 < 0n && a0 !== INT64_MIN ? -a0 : a0) : new FloatVal(Math.abs(a0.v));
      if (fn === 'ceil') return new FloatVal(Math.ceil(asDouble(a0)));
      if (fn === 'floor') return new FloatVal(Math.floor(asDouble(a0)));
      if (fn === 'round') return isInt(a0) ? a0 : saturateInt(a0.v, Math.round);
      if (fn === 'sqrt') return new FloatVal(Math.sqrt(asDouble(a0)));
      if (fn === 'pow') return new FloatVal(Math.pow(asDouble(a0), asDouble(args[1])));
      if (fn === 'isNaN') return Number.isNaN(asDouble(a0));
      fail('Unknown math method ' + fn);
    }
    if (space === 'timestamp') {
      if (fn === 'value') {
        const ms = requireInt(args[0]);
        if (ms < MIN_TS_MS || ms > MAX_TS_MS) fail('Timestamp out of range');
        return tsFromMillis(Number(ms));
      }
      if (fn === 'date') {
        const [y, m, d] = args.map((v) => Number(requireInt(v)));
        return tsFromYMD(y, m, d);
      }
      fail('Unknown timestamp method ' + fn);
    }
    if (space === 'duration') {
      if (fn === 'value') {
        const mag = requireInt(args[0]);
        const u = text(args[1]);
        if (!Object.hasOwn(DUR_UNITS, u)) fail('Unknown duration unit');
        return durFromNanos(mag * DUR_UNITS[u]);
      }
      if (fn === 'time') {
        const [h, m, s, n] = args.map(requireInt);
        return durFromNanos((h * 3600n + m * 60n + s) * BIG_NANOS_PER_SEC + n);
      }
      if (fn === 'abs') {
        if (!(args[0] instanceof DurationVal)) fail('Expected a duration');
        return new DurationVal(Math.abs(args[0].s), Math.abs(args[0].n));
      }
      fail('Unknown duration method ' + fn);
    }
    fail('Unknown namespace ' + space);
  }
`;
