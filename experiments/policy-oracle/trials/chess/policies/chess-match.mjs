function runtime() {
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


// admit
function p0($, v0, v1, v2) {
  $.tick(46);
  return $.choose($.binary("!=",$.index(v0,"status"),"playing"),() => "playing",() => $.choose($.logical(true,() => $.binary("!=",$.kind(v2),"number"),() => $.binary("!=",v2,$.index(v0,"moveCount"))),() => "matchVersion",() => $.choose($.logical(true,() => $.logical(true,() => $.logical(true,() => $.binary("!=",$.kind(v1),"string"),() => $.binary("==",v1,"")),() => $.logical(false,() => $.binary("!=",$.index(v0,"currentTurn"),"host"),() => $.binary("!=",$.index(v0,"currentTurn"),"guest"))),() => $.binary("!=",v1,$.index(v0,$.index(v0,"currentTurn")))),() => "currentTurn",() => "ok")));
}

function entry0(...args) { if(args.length !== 3) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p0($, ...args.map(v => $.data(v)))); }
export { entry0 as admit };

// squareName
function p1($, v0) {
  $.tick(12);
  return $.binary("+",$.index("abcdefgh",$.binary("%",v0,8)),$.index("87654321",$.binary("/",v0,8)));
}

// targetName
function p2($, v0) {
  $.tick(9);
  return $.choose($.binary("==",v0,$.neg(1)),() => "",() => p1($, v0));
}

// metadata
function p3($, v0, v1, v2, v3, v4) {
  $.tick(109);
  const v5 = $.binary("+",$.index(v1,0),$.index(v1,1));
  const v6 = $.binary("+",$.index(v1,2),$.index(v1,3));
  const v8 = $.traverse("select",$.range(64),v7 => $.logical(false,() => $.logical(false,() => $.binary("!=",$.index($.index(v2,"board"),v7),$.index($.index(v3,"board"),v7)),() => $.binary("!=",p1($, v7),v5)),() => $.binary("!=",p1($, v7),v6)),64);
  const v10 = $.sorted($.traverse("map",v8,v9 => p1($, v9),64));
  return $.choose($.logical(false,() => $.logical(false,() => $.binary("!=",v4,"playing"),() => $.binary("!=",v4,"checkmate")),() => $.binary("!=",v4,"stalemate")),() => $.fail("invalidOutcome"),() => $.makeRecord({["currentTurn"]:$.choose($.binary("==",$.index(v0,"currentTurn"),"host"),() => "guest",() => "host"), ["moveCount"]:$.binary("+",$.index(v0,"moveCount"),1), ["status"]:$.choose($.binary("==",v4,"checkmate"),() => "won",() => $.choose($.binary("==",v4,"stalemate"),() => "draw",() => "playing")), ["winner"]:$.choose($.binary("==",v4,"checkmate"),() => $.index(v0,"currentTurn"),() => ""), ["lastMove"]:$.makeRecord({["from"]:v5, ["to"]:v6, ["promotion"]:$.choose($.binary("==",$.size(v1),5),() => $.index(v1,4),() => ""), ["extra"]:v10}), ["castling"]:$.index(v3,"castling"), ["enPassant"]:p2($, $.index(v3,"enPassant")), ["prevCastling"]:$.index(v2,"castling"), ["prevEnPassant"]:p2($, $.index(v2,"enPassant"))}));
}

function entry3(...args) { if(args.length !== 5) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p3($, ...args.map(v => $.data(v)))); }
export { entry3 as metadata };
