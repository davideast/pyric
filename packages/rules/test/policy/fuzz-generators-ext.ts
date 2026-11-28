// Extended deterministic seeded generators for >=10,000-case differential fuzzing:
// nested derive/bounded.*/helper DAGs, RE2 Unicode/surrogate/backtracking boundaries,
// extended Firestore/RTDB/Storage policies, and split-enforcement mixed policies.
// Strictly 7-bit ASCII: all non-ASCII test characters use \uXXXX escapes.
import type { SeededRng } from './fuzz-prng.js';
import {
  generateFirestoreTransition,
  generateRtdbExpr,
  generateStorageTransition,
  printExpr,
  printTransition,
} from './fuzz-grammar.js';
import { STORAGE_EDGE_MIMES, UNICODE_EDGE_STRINGS } from './fuzz-values.js';

export type SplitTarget = 'firestore' | 'rtdb' | 'storage';
export type SplitOrder = 'db-first' | 'gateway-first' | 'interleaved';

export interface SplitPolicySpec {
  readonly target: SplitTarget;
  readonly order: SplitOrder;
  readonly method?: 'create' | 'update';
  readonly fullSource: string;
  readonly residualSource: string;
  readonly orderKinds: readonly ('db' | 'gateway')[];
  readonly reqNames: readonly string[];
}

export function generateHelperDagModule(rng: SeededRng, id: number): { source: string; entryName: string } {
  const leafOp = rng.pick(['x + 1', 'x * 2', 'x - 3', 'x > 0 ? x : -x', '(x is int) ? x + 1 : 0']);
  const boundA = rng.int(2, 5);
  const boundB = rng.int(2, 5);
  const midExpr = rng.pick([
    `bounded.map(xs, x => leaf(x), ${boundA})`,
    `bounded.select(xs, x => leaf(x) > 0, ${boundA})`,
    `bounded.flatMap(xs, x => [x, leaf(x)], ${boundA})`,
    `bounded.append(xs, ys, ${boundA})`,
  ]);
  const aggExpr = rng.pick([
    `bounded.fold(mid, seed, (acc, v) => { let s = leaf(v); return acc + s; }, ${boundB})`,
    `bounded.count(mid, v => v > seed, ${boundB})`,
    `bounded.any(mid, v => (v == seed) || (leaf(v) > 5), ${boundB})`,
    `bounded.all(mid, v => (v != 0) && (leaf(v) >= -10), ${boundB})`,
    `bounded.map(bounded.select(mid, v => v != null, ${boundB}), v => leaf(v), ${boundB})`,
  ]);
  const combExpr = rng.pick([
    'left(xs, ys, seed) == right(xs, seed)',
    "{'l': left(xs, ys, seed), 'r': right(xs, seed), 's': leaf(seed)}",
    '((left(xs, ys, seed) is int) && (right(xs, seed) is int)) ? left(xs, ys, seed) + right(xs, seed) : right(xs, seed)',
    '(left(xs, ys, seed) == 0) || (right(xs, seed) == 0)',
  ]);
  const entryName = `dag_${id}`;
  const source = [
    'use extension bounded;',
    `function leaf(x) { return ${leafOp}; }`,
    `function left(xs, ys, seed) { let mid = ${midExpr}; let unused = seed / 0; return ${aggExpr}; }`,
    `function right(xs, seed) { let base = leaf(seed); return bounded.fold(xs, base, (a, e) => a + leaf(e), ${boundA}); }`,
    `export function ${entryName}(xs, ys, seed) { return ${combExpr}; }`,
  ].join('\n');
  return { source, entryName };
}

export function generateDeriveDagTransition(rng: SeededRng, id: number): { source: string } {
  const b1 = rng.int(2, 4);
  const b2 = rng.int(2, 5);
  const scale = rng.pick([1, 2, -1]);
  const useHelper = rng.bool(0.7);
  const deriveLet = rng.pick([
    `let mapped = bounded.map(input.xs, x => ${useHelper ? 'step(x)' : `x * ${scale}`}, ${b1});`,
    `let mapped = bounded.select(input.xs, x => x > 0, ${b1});`,
    `let mapped = bounded.append(input.xs, input.ys, ${b1});`,
  ]);
  const totalExpr = rng.pick([
    `bounded.fold(mapped, before.score, (acc, v) => { let d = v * ${scale}; return acc + d; }, ${b2})`,
    `before.score + bounded.count(mapped, v => v >= 0, ${b2})`,
  ]);
  const req2 = rng.pick([
    `return bounded.any(input.xs, x => x > 0, ${b1}) || after.score == derived.total;`,
    `return bounded.all(input.xs, x => x != 99, ${b1}) && after.score >= derived.total;`,
    `let extra = bounded.append(input.xs, input.ys, ${b2}); return extra.size() >= 0;`,
    `let c = bounded.count(input.xs, x => (1 / x) == 1, ${b1}); return c >= 0 || after.flag == true;`,
  ]);
  const helper = useHelper
    ? `function bump(n) { return n + 1; }\nfunction step(n) { return bump(n) * ${scale}; }\n`
    : '';
  const source = [
    'use extension bounded;',
    'use extension derive;',
    'use extension methods;',
    helper + `transition dagT_${id} {`,
    '  derive {',
    `    ${deriveLet}`,
    `    let total = ${totalExpr};`,
    `    let ok = bounded.any(mapped, v => v > 0, ${b2});`,
    "    return { 'total': total, 'ok': ok, 'n': mapped.size() };",
    '  }',
    '  require checkTotal {',
    '    return after.score == derived.total || (derived.ok && after.score >= 0);',
    '  }',
    '  require checkExtra {',
    `    ${req2}`,
    '  }',
    '}',
  ].join('\n');
  return { source };
}

export function generateExtendedFirestoreTransition(rng: SeededRng): { source: string } {
  const mode = rng.weighted([
    [4, 'base'],
    [3, 'methods'],
    [2, 'derive'],
  ]);
  if (mode === 'base') {
    return { source: printTransition(generateFirestoreTransition(rng)) };
  }
  if (mode === 'derive') {
    const op = rng.pick(['+', '-', '*']);
    const k = rng.pick([1, 2, 3, -1]);
    const expr = rng.pick([
      `before.x ${op} ${k}`,
      `before.x ${op} input.x`,
      `before.flag ? before.x + ${k} : before.x - ${k}`,
    ]);
    return {
      source: [
        'use extension derive;',
        'transition fsDerive {',
        '  derive {',
        `    let nextX = ${expr};`,
        "    return { 'x': nextX };",
        '  }',
        '  require matchX {',
        '    return after.x == derived.x;',
        '  }',
        '}',
      ].join('\n'),
    };
  }
  const pat = rng.pick([
    '^[a-z]+$',
    '^[a-z0-9_/-]+$',
    '^\\Qabc\\E(?i)d$',
    '(?i)^[a-z]+$',
    '^text/\\s+$',
    '^a[0-9]*z$',
  ]);
  const atoms = [
    `after.s is string && after.s.matches(${JSON.stringify(pat)})`,
    'after.s is string && after.s.size() >= 0 && after.s.size() <= 8',
    'after.s is string && before.s is string && after.s.lower() == before.s.lower()',
    "after.s is string && after.s.upper() != ''",
    'after.s is string && after.s.trim().size() <= after.s.size()',
    "after.s is string && after.s.replace('[0-9]+', '#') != ''",
    "after.s is string && after.s.split(',').size() >= 1",
    "after.meta is map && after.meta.get('owner', '') == input.tag",
    "after.items is list && after.items.hasAny(['ok', 1])",
    "after.items is list && after.items.hasOnly(['ok', 1, 2])",
    "after.tag in ['ok', 'go', 'a']",
    'after.x is int && after.x >= before.x',
    'after.x is float || after.x == 0',
  ];
  const a1 = rng.pick(atoms);
  const a2 = rng.pick(atoms);
  const op = rng.pick(['&&', '||']);
  const neg = rng.bool(0.25);
  const cond = neg ? `!(${a1}) ${op} (${a2})` : `(${a1}) ${op} (${a2})`;
  return {
    source: [
      'use extension methods;',
      'transition fsExt {',
      '  require check {',
      `    return ${cond};`,
      '  }',
      '}',
    ].join('\n'),
  };
}

export function generateExtendedRtdbTransition(rng: SeededRng): { source: string; ruleKind: 'validate' | 'write' } {
  const mode = rng.weighted([
    [4, 'grammar'],
    [3, 'edge'],
    [2, 'write-null'],
  ]);
  if (mode === 'grammar') {
    const expr = generateRtdbExpr(rng, 3);
    return {
      ruleKind: 'validate',
      source: [
        'use extension methods;',
        'transition rtdbG {',
        '  require check {',
        `    return ${printExpr(expr)};`,
        '  }',
        '}',
      ].join('\n'),
    };
  }
  if (mode === 'write-null') {
    const pred = rng.pick([
      'before == null || after != null',
      'after == null || after.x > 0',
      'before != null && after == null',
      'before == null && after.x is int',
      '!(before == null) && (after == null || after.x >= before.x)',
      'after != null && (after.flag == true || after.x >= 0)',
      '(before == null ? after.x == 1 : after.x == before.x + 1)',
      'after == null || (after.s is string && after.s.size() <= 4)',
    ]);
    return {
      ruleKind: 'write',
      source: [
        'use extension methods;',
        'transition rtdbWrite {',
        '  require check {',
        `    return ${pred};`,
        '  }',
        '}',
      ].join('\n'),
    };
  }
  // Targeted RTDB edge probes: compound `is bool`, ternary same-guard overflow,
  // dual-polarity negation, float/safe-int mod/arithmetic, null checks, and let bindings.
  const template = rng.pick([
    'return (after.x > 0 || after.y > 0) is bool;',
    'return (after.x > 0 && after.y > 0) is bool;',
    'return (after.x > after.y) is bool;',
    'return (after.flag ? after.x > 0 : after.y > 0) is bool;',
    'return (after.x is int) is bool;',
    'return (after.x == 1) is bool;',
    'return !((after.x > 0 || after.y > 0) is bool);',
    'return (after.flag ? after.x * after.x : after.x + 1) > 0;',
    'return (after.flag ? after.x + after.y : after.x - 1) >= 0;',
    'return (after.x % 2 == 0) || (after.x % 3 == 1);',
    'return (after.x % 2 == 1.5) || (after.x % 2 == -1.5);',
    'return after.x is int && after.x >= -9007199254740991 && after.x <= 9007199254740991;',
    'return after.x != null && after.x != 1 && after.x != true;',
    'return (after.x > 0 || after.y > 0) == false;',
    'return (after.x < after.y) != (before.x < before.y);',
    'return after.s.size() >= 1 && after.s.size() <= 4;',
    "return (after.s + '!') == (before.s + '!');",
    'let ok = after.x > 0 || after.y > 0; return !ok;',
    'let delta = after.x - before.x; return delta == 1 || delta == 0;',
    'return (after.x > 0) == after.flag;',
    'return (after.x > 0) != after.flag;',
    'return after.x + 1 == before.x + 2;',
  ]);
  return {
    ruleKind: 'validate',
    source: [
      'use extension methods;',
      'transition rtdbEdge {',
      '  require check {',
      `    ${template}`,
      '  }',
      '}',
    ].join('\n'),
  };
}

export function generateExtendedStorageTransition(
  rng: SeededRng,
  mode: 'create' | 'update',
): { source: string } {
  if (rng.bool(0.45)) {
    return { source: printTransition(generateStorageTransition(rng, mode)) };
  }
  const atoms = [
    `after.size >= 0 && after.size <= ${rng.pick([0, 1, 64, 1024, 4096, 1048576, 9007199254740991])}`,
    "after.contentType.matches('^audio/(wav|ogg|mpeg)$')",
    "after.contentType.matches('(?i)^audio/wav$')",
    "after.contentType.matches('^\\\\Qaudio\\\\E(?i)/wav$')",
    "after.contentType.matches('^text/plain(;.*)?$')",
    "after.contentType.matches('^text/\\\\s+plain$')",
    "after.contentType.lower() == 'audio/wav'",
    "after.name.matches('^items/[a-zA-Z0-9._/% -]+$')",
    "after.name.size() <= 48",
    "after.metadata.get('owner', '') == input.auth.uid",
    "after.metadata.get(['owner'], '') != ''",
    "after.metadata.keys().size() <= 3",
    "after.metadata.hasAny(['owner', 'tag'])",
    "after.metadata.hasOnly(['owner', 'tag', 'role'])",
    `after.contentType in [${JSON.stringify(rng.pick(STORAGE_EDGE_MIMES))}, 'image/png']`,
    'input.auth != null',
    'input.auth is map',
    ...(mode === 'update'
      ? [
          'before != null && after.size >= before.size',
          "before.metadata.get('owner', '') == after.metadata.get('owner', '')",
          'before.contentType == after.contentType',
          'before != null || after.size <= 64',
        ]
      : []),
  ];
  const a1 = rng.pick(atoms);
  const a2 = rng.pick(atoms);
  const op = rng.pick(['&&', '||']);
  // Test bare-root under both && and || polarity (including unguarded auth cases).
  const rootChoice = rng.int(0, 3);
  let body: string;
  if (rootChoice === 0) body = `(input.auth != null) && ((${a1}) ${op} (${a2}))`;
  else if (rootChoice === 1) body = `(input.auth != null) || (${a1})`;
  else if (rootChoice === 2) body = `(${a1}) ${op} (${a2})`;
  else body = `!(${a1}) && (${a2})`;
  return {
    source: [
      'use extension methods;',
      'transition stExt {',
      '  require check {',
      `    return ${body};`,
      '  }',
      '}',
    ].join('\n'),
  };
}

export function generateSplitPolicy(
  rng: SeededRng,
  target: SplitTarget,
  order: SplitOrder,
): SplitPolicySpec {
  const method: 'create' | 'update' | undefined =
    target === 'storage' ? (rng.bool() ? 'create' : 'update') : undefined;
  const dbPred = target === 'firestore'
    ? rng.pick([
        'after.x > 0 && after.x <= 100',
        'after.x == before.x + 1',
        "after.tag in ['ok', 'go']",
        'after.flag == true || after.x >= 5',
        '(1 / after.x) > 0',
      ])
    : target === 'rtdb'
      ? rng.pick([
          'after.x > 0 && after.x <= 100',
          'after.x == before.x + 1',
          'after.flag == true || after.x >= 5',
          '(after.x > 0 || after.y > 0) is bool',
          'after.s.size() >= 1 && after.s.size() <= 6',
        ])
      : rng.pick([
          'input.auth != null && after.size <= 4096',
          "after.contentType.matches('^(audio|image)/[a-z]+$')",
          "input.auth != null && after.metadata.get('owner', '') == input.auth.uid",
          'after.size > 0 && after.size <= 1024',
          ...(method === 'update' ? ['after.size >= before.size'] : []),
        ]);
  const dbPred2 = target === 'firestore'
    ? 'after.x >= 0'
    : target === 'rtdb'
      ? 'after.x is int'
      : 'after.size >= 0';
  const listPath = target === 'firestore'
    ? 'input.items'
    : target === 'rtdb'
      ? 'input.items'
      : 'input.auth.token.items';
  const bound = rng.int(2, 3);
  const gwBody = rng.pick([
    `return bounded.count(${listPath}, v => v > 0, ${bound}) >= 1;`,
    `return bounded.any(${listPath}, v => (1 / v) == 1, ${bound}) || false;`,
    `return bounded.all(${listPath}, v => v >= 0, ${bound});`,
    `let s = bounded.fold(${listPath}, 0, (acc, v) => acc + v, ${bound}); return s >= 0;`,
    `return (bounded.count(${listPath}, v => v > 0, ${bound}) >= 0) || true;`,
  ]);
  const reqDefs: Array<{ name: string; kind: 'db' | 'gateway'; body: string }> =
    order === 'db-first'
      ? [
          { name: 'dbMain', kind: 'db', body: `return ${dbPred};` },
          { name: 'gwMain', kind: 'gateway', body: gwBody },
        ]
      : order === 'gateway-first'
        ? [
            { name: 'gwMain', kind: 'gateway', body: gwBody },
            { name: 'dbMain', kind: 'db', body: `return ${dbPred};` },
          ]
        : [
            { name: 'dbPre', kind: 'db', body: `return ${dbPred2};` },
            { name: 'gwMain', kind: 'gateway', body: gwBody },
            { name: 'dbMain', kind: 'db', body: `return ${dbPred};` },
          ];
  const header = 'use extension bounded;\nuse extension methods;\n';
  const render = (defs: typeof reqDefs, name: string) =>
    header +
    `transition ${name} {\n` +
    defs.map((d) => `  require ${d.name} {\n    ${d.body}\n  }`).join('\n') +
    '\n}';
  const residualDefs = reqDefs.filter((d) => d.kind === 'gateway');
  return {
    target,
    order,
    ...(method ? { method } : {}),
    fullSource: render(reqDefs, 'splitFull'),
    residualSource: render(residualDefs, 'splitResidual'),
    orderKinds: reqDefs.map((d) => d.kind),
    reqNames: reqDefs.map((d) => d.name),
  };
}

export const RE2_CURATED_PATTERNS: readonly string[] = [
  '',
  '.',
  '^',
  '$',
  '\\A',
  '\\z',
  '\\b',
  '\\B',
  'a*',
  'a+',
  'a?',
  '(?i)k',
  '(?i)s',
  '(?i)[a-z]',
  '(?i)\\u03c3'.replace('\\u03c3', '\u03c3'),
  '(?i)' + '\u00df',
  '(?i)' + '\u00c5',
  '(?i)' + '\u03a9',
  '(?i)' + '\u0412',
  '\\Qabc\\E(?i)d',
  '(?i)\\Qabc\\E(?-i)d',
  '\\Qa.b+c\\E',
  '\\Qa.b',
  '\\E',
  '\\s',
  '\\S',
  '\\d',
  '\\D',
  '\\w',
  '\\W',
  '[[:space:]]',
  '[[:^digit:]]',
  '[[:punct:]]',
  '[[:word:]]',
  '[[:alpha:]]',
  '[[:xdigit:]]',
  '[[:foo:]]',
  '\\p{L}',
  '\\P{L}',
  '\\p{^L}',
  '\\p{Ll}',
  '(?i)\\p{Ll}',
  '(?i)\\p{Lu}',
  '\\p{Greek}',
  '\\p{Cyrillic}',
  '\\p{^Greek}',
  '\\pL',
  '\\pX',
  '\\p{NoSuch}',
  '[' + '\uD83D\uDE00' + '-' + '\uD83D\uDE05' + ']',
  '\\x{110000}',
  '\\x{000000001}',
  '\\x{41}',
  '\\x{1F600}',
  '\\x{D800}',
  '\\x{}',
  '\\x41',
  '\\0',
  '\\077',
  '\\10',
  '\\77',
  '\\377',
  '\\400',
  '\\1',
  '[\\1]',
  '[\\10]',
  '[\\77]',
  '(?P<a>a)(?<a>a)',
  '(?<1a>a)',
  '(?<>a)',
  '\\a',
  '\\f',
  '\\v',
  '\\c',
  '\\e',
  '\\h',
  '\\u',
  '\\Z',
  '[\\b]',
  '[\\Z]',
  'a**',
  'a++',
  'a{1,2}{1,2}',
  'a{0,1001}',
  '^*a',
  '$*',
  '\\b+',
  '\\B*',
  '\\A+',
  '\\z*',
  '(?i)*',
  '()*',
  '(a*)*',
  '(?m)^a$',
  '(?m)^',
  '(?s)a.b',
  'a.b',
  '(?U)a+',
  '(?P<tag>[a-z]+)',
  '(?<tag>[a-z]+)',
  '(a)\\1',
  'a(?=b)b',
  'a(?<=a)b',
  'a\\',
  '[]]',
  '[^]]',
  '[a-]',
  '[^a]',
  '[z-a]',
  '[\\d-z]',
  '[\\p{L}-z]',
  '[[:digit:]-z]',
  '[0-[:digit:]]',
  '[[:digit:]-]',
  '[\\d-]',
];

export const RE2_BACKTRACK_CASES: readonly (readonly [string, string])[] = [
  ['a'.repeat(32) + '!', '(a+)+b'],
  ['a'.repeat(32) + '!', '(a|aa)+b'],
  ['a'.repeat(28) + '!', '(a*)*b'],
  ['a'.repeat(28) + '!', '([a-z]+)*!z'],
  ['a'.repeat(20), 'a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?aaaaaaaaaaaaaaaaaaaa'],
  ['a'.repeat(25) + '!', '(a|a?)+b'],
  ['ab'.repeat(20) + '!', '((ab)+)+c'],
];

export const RE2_REPLACE_TEMPLATES: readonly string[] = [
  '#',
  '',
  '$0',
  '[$0]',
  '$1',
  '$2',
  '$1-$2',
  '${tag}',
  '${missing}',
  '\\$1',
  '\\\\',
  'x\\',
  '$$',
  '\uD83D\uDE00',
];

export function generateRe2Case(rng: SeededRng): {
  subject: string;
  pattern: string;
  replacement: string;
  op: 'matches' | 'absorb' | 'split' | 'replace';
} {
  const op = rng.weighted([
    [4, 'matches' as const],
    [2, 'absorb' as const],
    [2, 'split' as const],
    [2, 'replace' as const],
  ]);
  const useRandomPat = rng.bool(0.35);
  let pattern: string;
  if (!useRandomPat) {
    pattern = rng.pick(RE2_CURATED_PATTERNS);
  } else {
    const pieces = [
      'a', 'b', 'k', 's', '.', '\\d', '\\s', '\\w', '\\p{L}', '[a-z]', '[^a]',
      '(a|b)', '(?i)', '(?-i)', '(?m)', '(?s)', '(?U)', '^', '$', '\\A', '\\z', '\\b',
      '\\Qab\\E', '(?P<tag>a+)', '\uD83D\uDE00', '\u03c3', '\u017f',
    ];
    const quants = ['', '', '', '*', '+', '?', '{0,2}', '{1,3}', '*?'];
    const count = rng.int(1, 3);
    let out = '';
    for (let i = 0; i < count; i++) {
      const p = rng.pick(pieces);
      const q = p.startsWith('(?') && !p.startsWith('(?P') ? '' : rng.pick(quants);
      out += p + q;
    }
    pattern = out;
  }
  const subject = rng.bool(0.75)
    ? rng.pick(UNICODE_EDGE_STRINGS)
    : rng.pick(['ABCd', 'ABcd', 'abCD', 'a1b2', 'foo,bar,', '  hi  ', 'aaab', 'ab']);
  const replacement = rng.pick(RE2_REPLACE_TEMPLATES);
  return { subject, pattern, replacement, op };
}
