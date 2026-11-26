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


// rank
function p0($, v0) {
  $.tick(4);
  return $.binary("/",v0,8);
}

// file
function p1($, v0) {
  $.tick(4);
  return $.binary("%",v0,8);
}

// squareName
function p2($, v0) {
  $.tick(10);
  return $.binary("+",$.index("abcdefgh",p1($, v0)),$.index("87654321",p0($, v0)));
}

// squareAt
function p3($, v0, v1) {
  $.tick(28);
  const v2 = $.locate("abcdefgh", $.index(v0,v1));
  const v3 = $.locate("87654321", $.index(v0,$.binary("+",v1,1)));
  return $.choose($.logical(true,() => $.binary("<",v2,0),() => $.binary("<",v3,0)),() => $.neg(1),() => $.binary("+",$.binary("*",v3,8),v2));
}

// other
function p4($, v0) {
  $.tick(7);
  return $.choose($.binary("==",v0,"w"),() => "b",() => "w");
}

// pawnDir
function p5($, v0) {
  $.tick(8);
  return $.choose($.binary("==",v0,"w"),() => $.neg(1),() => 1);
}

// home
function p6($, v0) {
  $.tick(7);
  return $.choose($.binary("==",v0,"w"),() => 60,() => 4);
}

// kingRight
function p7($, v0) {
  $.tick(7);
  return $.choose($.binary("==",v0,"w"),() => "K",() => "k");
}

// queenRight
function p8($, v0) {
  $.tick(7);
  return $.choose($.binary("==",v0,"w"),() => "Q",() => "q");
}

// belongs
function p9($, v0, v1) {
  $.tick(10);
  return $.logical(false,() => $.binary("!=",v0,""),() => $.binary("==",$.index(v0,0),v1));
}

// knownPiece
function p10($, v0) {
  $.tick(30);
  return $.logical(false,() => $.binary("==",$.kind(v0),"string"),() => $.logical(true,() => $.binary("==",v0,""),() => $.logical(false,() => $.logical(false,() => $.binary("==",$.size(v0),2),() => $.binary(">=",$.locate("wb", $.index(v0,0)),0)),() => $.binary(">=",$.locate("pnbrqk", $.index(v0,1)),0))));
}

// validPosition
function p11($, v0) {
  $.tick(126);
  return $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.binary("==",$.kind(v0),"object"),() => $.binary("==",$.kind($.index(v0,"board")),"list")),() => $.binary("==",$.size($.index(v0,"board")),64)),() => $.logical(true,() => $.binary("==",$.index(v0,"turn"),"w"),() => $.binary("==",$.index(v0,"turn"),"b"))),() => $.binary("==",$.kind($.index(v0,"castling")),"string")),() => $.binary("<=",$.size($.index(v0,"castling")),4)),() => $.not($.traverse("any",$.range($.size($.index(v0,"castling"))),v1 => $.logical(true,() => $.binary("<",$.locate("KQkq", $.index($.index(v0,"castling"),v1)),0),() => $.binary("!=",$.locate($.index(v0,"castling"), $.index($.index(v0,"castling"),v1)),v1)),4))),() => $.binary("==",$.kind($.index(v0,"enPassant")),"number")),() => $.logical(true,() => $.binary("==",$.index(v0,"enPassant"),$.neg(1)),() => $.logical(false,() => $.logical(false,() => $.binary(">=",$.index(v0,"enPassant"),0),() => $.binary("<",$.index(v0,"enPassant"),64)),() => $.binary("==",p0($, $.index(v0,"enPassant")),$.choose($.binary("==",$.index(v0,"turn"),"w"),() => 2,() => 5))))),() => $.not($.traverse("any",$.index(v0,"board"),v2 => $.not(p10($, v2)),64))),() => $.binary("==",$.size($.traverse("select",$.index(v0,"board"),v3 => $.binary("==",v3,"wk"),64)),1)),() => $.binary("==",$.size($.traverse("select",$.index(v0,"board"),v4 => $.binary("==",v4,"bk"),64)),1));
}

// clearRay
function p12($, v0, v1, v2, v3, v4) {
  $.tick(35);
  const v5 = $.choose($.binary(">",$.abs(v3),$.abs(v4)),() => $.abs(v3),() => $.abs(v4));
  const v6 = $.binary("+",$.binary("*",$.sign(v4),8),$.sign(v3));
  return $.not($.traverse("any",$.range($.binary("-",v5,1)),v7 => $.binary("!=",$.index(v0,$.binary("+",v1,$.binary("*",$.binary("+",v7,1),v6))),""),7));
}

// attacks
function p13($, v0, v1, v2) {
  $.tick(96);
  const v3 = $.index(v0,v1);
  const v4 = $.index(v3,1);
  const v5 = $.binary("-",p1($, v2),p1($, v1));
  const v6 = $.binary("-",p0($, v2),p0($, v1));
  const v7 = $.abs(v5);
  const v8 = $.abs(v6);
  const v9 = $.binary("==",v7,v8);
  const v10 = $.logical(true,() => $.binary("==",v7,0),() => $.binary("==",v8,0));
  return $.choose($.binary("==",v1,v2),() => false,() => $.choose($.binary("==",v4,"p"),() => $.logical(false,() => $.binary("==",v7,1),() => $.binary("==",v6,p5($, $.index(v3,0)))),() => $.choose($.binary("==",v4,"n"),() => $.binary("==",$.binary("*",v7,v8),2),() => $.choose($.binary("==",v4,"k"),() => $.logical(false,() => $.binary("<=",v7,1),() => $.binary("<=",v8,1)),() => $.logical(false,() => $.logical(true,() => $.logical(false,() => v9,() => $.logical(true,() => $.binary("==",v4,"q"),() => $.binary("==",v4,"b"))),() => $.logical(false,() => v10,() => $.logical(true,() => $.binary("==",v4,"q"),() => $.binary("==",v4,"r")))),() => p12($, v0, v1, v2, v5, v6))))));
}

// underAttack
function p14($, v0, v1, v2) {
  $.tick(14);
  return $.traverse("any",$.range(64),v3 => $.logical(false,() => p9($, $.index(v0,v3), v2),() => p13($, v0, v3, v1)),64);
}

// checked
function p15($, v0, v1) {
  $.tick(10);
  return p14($, v0, $.locate(v0, $.binary("+",v1,"k")), p4($, v1));
}

// inCheck
function p16($, v0) {
  $.tick(11);
  return $.choose(p11($, v0),() => p15($, $.index(v0,"board"), $.index(v0,"turn")),() => $.fail("invalidPosition"));
}

function entry16(...args) { if(args.length !== 1) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p16($, ...args.map(v => $.data(v)))); }
export { entry16 as inCheck };

// canCastle
function p17($, v0, v1, v2) {
  $.tick(101);
  const v3 = $.binary(">",v2,v1);
  const v4 = $.choose(v3,() => 1,() => $.neg(1));
  const v5 = $.choose(v3,() => p7($, $.index(v0,"turn")),() => p8($, $.index(v0,"turn")));
  const v6 = $.binary("+",v1,$.choose(v3,() => 3,() => $.neg(4)));
  return $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.binary("==",v1,p6($, $.index(v0,"turn"))),() => $.binary("==",v2,$.binary("+",v1,$.binary("*",2,v4)))),() => $.binary(">=",$.locate($.index(v0,"castling"), v5),0)),() => $.binary("==",$.index($.index(v0,"board"),v6),$.binary("+",$.index(v0,"turn"),"r"))),() => $.binary("==",$.index($.index(v0,"board"),$.binary("+",v1,v4)),"")),() => $.binary("==",$.index($.index(v0,"board"),v2),"")),() => $.logical(true,() => v3,() => $.binary("==",$.index($.index(v0,"board"),$.binary("-",v1,3)),""))),() => $.not(p14($, $.index(v0,"board"), v1, p4($, $.index(v0,"turn"))))),() => $.not(p14($, $.index(v0,"board"), $.binary("+",v1,v4), p4($, $.index(v0,"turn")))));
}

// pawnStep
function p18($, v0, v1, v2) {
  $.tick(89);
  const v3 = $.abs($.binary("-",p1($, v2),p1($, v1)));
  const v4 = $.binary("-",p0($, v2),p0($, v1));
  const v5 = p5($, $.index(v0,"turn"));
  const v6 = $.index($.index(v0,"board"),v2);
  return $.choose($.logical(false,() => $.binary("==",v3,1),() => $.binary("==",v4,v5)),() => $.logical(true,() => $.binary("!=",v6,""),() => $.logical(false,() => $.binary("==",v2,$.index(v0,"enPassant")),() => $.binary("==",$.index($.index(v0,"board"),$.binary("-",v2,$.binary("*",v5,8))),$.binary("+",p4($, $.index(v0,"turn")),"p")))),() => $.logical(false,() => $.logical(false,() => $.binary("==",v3,0),() => $.binary("==",v6,"")),() => $.logical(true,() => $.binary("==",v4,v5),() => $.logical(false,() => $.logical(false,() => $.binary("==",v4,$.binary("*",2,v5)),() => $.binary("==",p0($, v1),$.choose($.binary("==",$.index(v0,"turn"),"w"),() => 6,() => 1))),() => $.binary("==",$.index($.index(v0,"board"),$.binary("+",v1,$.binary("*",8,v5))),"")))));
}

// shape
function p19($, v0, v1, v2) {
  $.tick(64);
  const v3 = $.index($.index(v0,"board"),v1);
  const v4 = $.index($.index(v0,"board"),v2);
  return $.logical(false,() => $.logical(false,() => $.logical(false,() => $.logical(false,() => $.binary("!=",v1,v2),() => p9($, v3, $.index(v0,"turn"))),() => $.not(p9($, v4, $.index(v0,"turn")))),() => $.binary("!=",v4,$.binary("+",p4($, $.index(v0,"turn")),"k"))),() => $.choose($.binary("==",$.index(v3,1),"p"),() => p18($, v0, v1, v2),() => $.choose($.logical(false,() => $.binary("==",$.index(v3,1),"k"),() => $.binary("==",$.abs($.binary("-",v2,v1)),2)),() => p17($, v0, v1, v2),() => p13($, $.index(v0,"board"), v1, v2))));
}

// moveRook
function p20($, v0, v1, v2) {
  $.tick(27);
  const v3 = $.binary("<",v1,v2);
  const v4 = $.binary("+",v1,$.choose(v3,() => 3,() => $.neg(4)));
  const v5 = $.binary("+",v1,$.choose(v3,() => 1,() => $.neg(1)));
  return $.replaceAt($.replaceAt(v0, v5, $.index(v0,v4)), v4, "");
}

// nextBoard
function p21($, v0, v1, v2, v3) {
  $.tick(67);
  const v4 = $.index($.index(v0,"board"),v1);
  const v5 = $.replaceAt($.replaceAt($.index(v0,"board"), v1, ""), v2, $.choose($.binary("==",v3,""),() => v4,() => $.binary("+",$.index(v0,"turn"),v3)));
  return $.choose($.logical(false,() => $.logical(false,() => $.binary("==",$.index(v4,1),"p"),() => $.binary("==",v2,$.index(v0,"enPassant"))),() => $.binary("==",$.index($.index(v0,"board"),v2),"")),() => $.replaceAt(v5, $.binary("-",v2,$.binary("*",p5($, $.index(v0,"turn")),8)), ""),() => $.choose($.logical(false,() => $.binary("==",$.index(v4,1),"k"),() => $.binary("==",$.abs($.binary("-",v2,v1)),2)),() => p20($, v5, v1, v2),() => v5));
}

// needsPromotion
function p22($, v0, v1, v2) {
  $.tick(20);
  return $.logical(false,() => $.binary("==",$.index($.index($.index(v0,"board"),v1),1),"p"),() => $.binary("==",p0($, v2),$.choose($.binary("==",$.index(v0,"turn"),"w"),() => 0,() => 7)));
}

// legalPair
function p23($, v0, v1, v2) {
  $.tick(15);
  return $.logical(false,() => p19($, v0, v1, v2),() => $.not(p15($, p21($, v0, v1, v2, ""), $.index(v0,"turn"))));
}

// movesAt
function p24($, v0, v1) {
  $.tick(34);
  const v3 = $.traverse("select",$.range(64),v2 => p23($, v0, v1, v2),64);
  return $.traverse("flatMap",v3,v4 => $.choose(p22($, v0, v1, v4),() => $.traverse("map",$.makeList(["b", "n", "q", "r"]),v5 => $.binary("+",$.binary("+",p2($, v1),p2($, v4)),v5),4),() => $.makeList([$.binary("+",p2($, v1),p2($, v4))])),64);
}

// moves
function p25($, v0) {
  $.tick(17);
  const v2 = $.traverse("select",$.range(64),v1 => p9($, $.index($.index(v0,"board"),v1), $.index(v0,"turn")),64);
  return $.sorted($.traverse("flatMap",v2,v3 => p24($, v0, v3),64));
}

// legalMoves
function p26($, v0) {
  $.tick(8);
  return $.choose(p11($, v0),() => p25($, v0),() => $.fail("invalidPosition"));
}

function entry26(...args) { if(args.length !== 1) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p26($, ...args.map(v => $.data(v)))); }
export { entry26 as legalMoves };

// flagForCorner
function p27($, v0) {
  $.tick(22);
  return $.choose($.binary("==",v0,0),() => "q",() => $.choose($.binary("==",v0,7),() => "k",() => $.choose($.binary("==",v0,56),() => "Q",() => $.choose($.binary("==",v0,63),() => "K",() => ""))));
}

// nextRights
function p28($, v0, v1, v2) {
  $.tick(29);
  const v3 = $.choose($.binary("==",$.index($.index($.index(v0,"board"),v1),1),"k"),() => $.omit($.omit($.index(v0,"castling"), p7($, $.index(v0,"turn"))), p8($, $.index(v0,"turn"))),() => $.index(v0,"castling"));
  return $.omit($.omit(v3, p27($, v1)), p27($, v2));
}

// applyParsed
function p29($, v0, v1, v2, v3) {
  $.tick(73);
  const v4 = $.logical(false,() => $.logical(false,() => $.logical(false,() => $.binary(">=",v1,0),() => $.binary(">=",v2,0)),() => p23($, v0, v1, v2)),() => $.choose(p22($, v0, v1, v2),() => $.logical(false,() => $.binary("==",$.size(v3),1),() => $.binary(">=",$.locate("bnqr", v3),0)),() => $.binary("==",v3,"")));
  return $.choose($.not(v4),() => $.fail("illegalMove"),() => $.makeRecord({["board"]:p21($, v0, v1, v2, v3), ["turn"]:p4($, $.index(v0,"turn")), ["castling"]:p28($, v0, v1, v2), ["enPassant"]:$.choose($.logical(false,() => $.binary("==",$.index($.index($.index(v0,"board"),v1),1),"p"),() => $.binary("==",$.abs($.binary("-",v2,v1)),16)),() => $.binary("/",$.binary("+",v1,v2),2),() => $.neg(1))}));
}

// apply
function p30($, v0, v1) {
  $.tick(41);
  return $.choose($.not(p11($, v0)),() => $.fail("invalidPosition"),() => $.choose($.logical(true,() => $.binary("!=",$.kind(v1),"string"),() => $.logical(false,() => $.binary("!=",$.size(v1),4),() => $.binary("!=",$.size(v1),5))),() => $.fail("illegalMove"),() => p29($, v0, p3($, v1, 0), p3($, v1, 2), $.choose($.binary("==",$.size(v1),5),() => $.index(v1,4),() => ""))));
}

function entry30(...args) { if(args.length !== 2) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p30($, ...args.map(v => $.data(v)))); }
export { entry30 as apply };

// hasMove
function p31($, v0) {
  $.tick(19);
  return $.traverse("any",$.range(64),v1 => $.logical(false,() => p9($, $.index($.index(v0,"board"),v1), $.index(v0,"turn")),() => $.traverse("any",$.range(64),v2 => p23($, v0, v1, v2),64)),64);
}

// outcome
function p32($, v0) {
  $.tick(19);
  return $.choose($.not(p11($, v0)),() => $.fail("invalidPosition"),() => $.choose(p31($, v0),() => "playing",() => $.choose(p15($, $.index(v0,"board"), $.index(v0,"turn")),() => "checkmate",() => "stalemate")));
}

function entry32(...args) { if(args.length !== 1) throw new Error("Invalid argument count"); const $ = runtime(); return $.read(p32($, ...args.map(v => $.data(v)))); }
export { entry32 as outcome };
