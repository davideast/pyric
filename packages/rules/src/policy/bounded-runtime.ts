// Embedded in the generated ES module. The same source runs in Node and browsers.
export const boundedRuntime = `function runtime() {
  let remaining = 1000000;
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
  function logical(determining, left, right) {
    let first;
    try {
      first = bool(read(left()));
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      const second = capture(value => bool(value), right());
      if (second === determining) return second;
      throw error;
    }
    return first === determining ? first : bool(read(right()));
  }
  function tick(amount = 1) {
    if ((remaining -= amount) < 0) limit('Evaluation budget exceeded');
  }
  function bool(x) {
    if (typeof x !== 'boolean') fail('Expected a boolean');
    return x;
  }
  function integer(x) {
    if (!Number.isSafeInteger(x)) fail('Expected a safe integer');
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
  function index(xs, i) {
    if (typeof xs === 'string' || Array.isArray(xs)) {
      integer(i);
      if (i < 0 || i >= xs.length) fail('Index outside collection');
    } else if (!xs || typeof xs !== 'object' || typeof i !== 'string') fail('Expected a record key');
    if (typeof xs === 'string') return text(xs)[i];
    const desc = Object.getOwnPropertyDescriptor(xs, i);
    if (!desc || !('value' in desc)) fail('Missing own data value');
    return desc.value;
  }
  // Copy plain input data into the evaluation. Bound work before traversing it.
  let inputNodes = 0;
  function data(value, depth = 0) {
    if (++inputNodes > 16384 || depth > 32) limit('Input depth or node bound exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return integer(value);
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) {
      list(value);
      const result = [];
      for (let i = 0; i < value.length; i++) result.push(data(index(value, i), depth + 1));
      return result;
    }
    if (!value || typeof value !== 'object') fail('Expected plain data');
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) fail('Expected plain record data');
    const result = {};
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++count > 4096) limit('Record size bound exceeded');
      text(key);
      Object.defineProperty(result, key, { value: data(index(value, key), depth + 1), enumerable: true });
    }
    return result;
  }
  function size(x) {
    return (typeof x === 'string' ? text(x) : list(x)).length;
  }
  function replaceAt(xs, i, v) {
    list(xs);
    index(xs, i);
    tick(xs.length);
    const copy = [...xs];
    copy[i] = v;
    return copy;
  }
  function range(n) {
    integer(n);
    if (n < 0 || n > 256) limit('Range bound exceeded');
    tick(n);
    return Array.from({ length: n }, (_, i) => i);
  }
  function locate(xs, v) {
    const n = size(xs);
    tick(n);
    return typeof xs === 'string' ? xs.indexOf(text(v)) : xs.indexOf(v);
  }
  function sorted(xs) {
    list(xs);
    tick(xs.length);
    if (!xs.every((v) => typeof v === 'string')) fail('Expected strings');
    return [...xs].sort();
  }
  function chain(xs, ys) {
    list(xs);
    list(ys);
    tick(xs.length + ys.length);
    if (xs.length + ys.length > 4096) limit('List result bound exceeded');
    return xs.concat(ys);
  }
  function omit(s, flag) {
    return text(s).replace(text(flag), '');
  }
  function add(a, b) {
    return typeof a === 'string' && typeof b === 'string' ? text(a + b) : integer(integer(a) + integer(b));
  }
  function eq(a, b) {
    if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object'))
      fail('Expected scalar equality');
    return a === b;
  }
  function binary(op, left, right) {
    if (op === '+' ) return add(left, right);
    if (op === '==') return eq(left, right);
    if (op === '!=') return !eq(left, right);
    const a = integer(left);
    const b = integer(right);
    switch (op) {
      case '-': return integer(a-b);
      case '*': return integer(a*b);
      case '/': return integer(Math.trunc(a/b));
      case '%': return integer(a%b);
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: throw new Error('Unknown operation');
    }
  }
  function traverse(op, xs, pred, bound) {
    list(xs);
    if (xs.length > bound) limit('Traversal bound exceeded');
    const result = [];
    let firstError;
    for (let i = 0; i < xs.length; i++) {
      tick();
      const value = index(xs, i);
      let answer = pred(value);
      if (op === 'any' || op === 'select') answer = capture(bool, answer);
      if (op === 'flatMap') answer = capture(list, answer);
      if (answer instanceof RuleError) {
        firstError ??= answer;
        continue;
      }
      if (op === 'any') {
        if (bool(answer)) return true;
      } else if (op === 'select') {
        if (bool(answer)) result.push(value);
      } else if (op === 'map') result.push(answer);
      else {
        const part = list(answer);
        if (part.length + result.length > 4096) limit('List result bound exceeded');
        tick(part.length);
        result.push(...part);
      }
    }
    return firstError ?? (op === 'any' ? false : result);
  }
  function kind(x) {
    return Array.isArray(x) ? 'list' : x === null ? 'null' : typeof x;
  }
  const operations = {
    logical,
    binary,
    neg: x => -integer(x),
    not: x => !bool(x),
    choose: (cond, yes, no) => bool(cond) ? yes() : no(),
    makeList: xs => { for (const x of xs) read(x); return xs; },
    makeRecord: obj => { for (const x of Object.values(obj)) read(x); return obj; },
    bool,
    integer,
    index,
    size,
    replaceAt,
    range,
    locate,
    sorted,
    chain,
    omit,
    add,
    eq,
    traverse,
    kind,
    fail: (msg) => {
      throw new Error(text(msg));
    },
    abs: (n) => Math.abs(integer(n)),
    sign: (n) => Math.sign(integer(n))
  };
  const api = {tick, data, read};
  for (const name of Object.keys(operations)) {
    api[name] = (...args) => capture(operations[name], ...args);
  }
  return api;
}
`;
