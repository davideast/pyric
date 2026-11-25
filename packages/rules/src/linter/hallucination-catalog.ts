/**
 * Static catalogs of hallucinated JavaScript methods, globals, context paths,
 * boolean token claims, and pre-parse operator hints used by `hallucinations.ts`.
 */

/**
 * JavaScript array/string methods that do not exist on any CEL type used in
 * Firestore or Storage rules (List, Map, String, Set, Timestamp, Path).
 */
export const HALLUCINATED_METHODS: Record<string, string> = {
  // Array methods
  where: 'No equivalent in rules -- restructure logic instead of filtering a list',
  filter: 'No equivalent in rules -- restructure logic instead of filtering a list',
  find: 'No equivalent in rules',
  findIndex: 'No equivalent in rules',
  map: 'No equivalent in rules -- lists are not transformable',
  reduce: 'No equivalent in rules',
  forEach: 'No equivalent in rules',
  every: 'Use `list.hasAll([...])` for "all elements present"',
  some: 'Use `list.hasAny([...])` for "any element present"',
  includes: 'Use `x in list` instead of `list.includes(x)`',
  indexOf: 'No equivalent in rules',
  push: 'Lists are immutable in rules',
  pop: 'Lists are immutable in rules',
  shift: 'Lists are immutable in rules',
  unshift: 'Lists are immutable in rules',
  splice: 'Lists are immutable in rules',
  slice: 'No equivalent in rules',
  sort: 'Lists are immutable in rules',
  reverse: 'Lists are immutable in rules',
  flat: 'No equivalent in rules',
  flatMap: 'No equivalent in rules',
  // String methods
  toLowerCase: 'Use `.lower()` instead of `.toLowerCase()`',
  toUpperCase: 'Use `.upper()` instead of `.toUpperCase()`',
  charAt: 'No equivalent in rules -- use `.split("")` and index',
  charCodeAt: 'No equivalent in rules',
  substring: 'No `.substring()` -- use `.split()` and reassembly',
  substr: 'No `.substr()` -- use `.split()` and reassembly',
  padStart: 'No equivalent in rules',
  padEnd: 'No equivalent in rules',
  trimStart: 'Use `.trim()` (trims both ends)',
  trimEnd: 'Use `.trim()` (trims both ends)',
  // Conversion
  toString: 'Use the `string(x)` cast instead of `.toString()`',
};

/**
 * JavaScript globals or constructors that do not exist as identifiers in
 * Security Rules.
 */
export const HALLUCINATED_GLOBALS: Record<string, string> = {
  Object: 'No `Object` in rules -- use `data.keys()` / `data.values()` directly',
  Array: 'No `Array` in rules -- test list type with `x is list`',
  JSON: 'No `JSON` in rules -- rules cannot parse or serialize JSON',
  Math: 'No `Math` in rules -- inline arithmetic or ternaries',
  Date: 'No `Date` in rules -- use `request.time` (a Timestamp)',
  String: 'Use lowercase `string(x)` for casting',
  Number: 'Use lowercase `int(x)` or `float(x)` for casting',
  Boolean: 'Use direct comparison or validation instead of boolean casting',
  bool: 'No `bool()` cast in rules -- boolean casting is not supported in production security rules.',
  parseInt: 'Use `int(x)` instead',
  parseFloat: 'Use `float(x)` instead',
  isNaN: 'No equivalent in rules',
  isFinite: 'No equivalent in rules',
  Promise: 'Rules are synchronous -- no Promise support',
  undefined: '`undefined` does not exist in rules -- use `null`',
};

export interface WrongPath {
  receiver: string;
  property: string;
  suggestion: string;
  storageSuggestion?: string;
  storageOnly?: boolean;
}

export const WRONG_CONTEXT_PATHS: readonly WrongPath[] = [
  {
    receiver: 'request',
    property: 'data',
    suggestion: 'Use `request.resource.data` (the incoming write payload)',
    storageSuggestion:
      'Use `request.resource` (e.g. `request.resource.size`, `request.resource.contentType`, or `request.resource.metadata`)',
  },
  {
    receiver: 'request',
    property: 'uid',
    suggestion: 'Use `request.auth.uid`',
  },
  {
    receiver: 'request',
    property: 'token',
    suggestion: 'Use `request.auth.token`',
  },
  {
    receiver: 'request',
    property: 'user',
    suggestion: 'Use `request.auth` (or `request.auth.uid` for the user id)',
  },
  {
    receiver: 'request.auth',
    property: 'id',
    suggestion: 'Use `request.auth.uid`',
  },
  {
    receiver: 'resource',
    property: 'path',
    suggestion: '`resource.path` is not available -- bind path captures in the match pattern',
  },
  {
    receiver: 'resource',
    property: 'exists',
    suggestion: 'Use `resource != null` (or `exists()` for cross-document checks)',
    storageSuggestion: 'Use `resource != null` (or `firestore.exists()` for cross-service document checks)',
  },
  {
    receiver: 'resource',
    property: 'id',
    suggestion: '`resource.id` is not available -- capture the document id with `/{docId}` in the match path',
    storageSuggestion: '`resource.id` is not available -- use `resource.name` or capture path segments in `match`',
  },
  {
    receiver: 'resource',
    property: 'data',
    suggestion:
      '`resource.data` does not exist in Storage rules -- use `resource.size`, `resource.contentType`, or `resource.metadata`',
    storageOnly: true,
  },
  {
    receiver: 'request.resource',
    property: 'data',
    suggestion:
      '`request.resource.data` does not exist in Storage rules -- use `request.resource.size`, `request.resource.contentType`, or `request.resource.metadata`',
    storageOnly: true,
  },
  {
    receiver: 'resource',
    property: 'timeUpdated',
    suggestion: 'Use `resource.updated` instead of `resource.timeUpdated`',
    storageOnly: true,
  },
  {
    receiver: 'request.resource',
    property: 'timeUpdated',
    suggestion: 'Use `request.resource.updated` instead of `request.resource.timeUpdated`',
    storageOnly: true,
  },
];

/** Auth-token claims typed `bool` in production (`email_verified`). */
export const BOOL_TOKEN_CLAIMS = new Set(['email_verified']);

/** Built-in CEL methods that are likely missing parentheses when read as properties. */
export const KNOWN_BUILTIN_METHODS = new Set([
  'size',
  'keys',
  'values',
  'lower',
  'upper',
  'trim',
  'hasAll',
  'hasAny',
  'hasOnly',
  'toSet',
  'toUtf8',
]);

/** Pre-parse JS operators and syntax forms not supported in Security Rules. */
export const SYNTAX_HINTS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern: /===/,
    message: 'Strict equality `===` is not supported in security rules -- use `==`.',
  },
  {
    pattern: /!==/,
    message: 'Strict inequality `!==` is not supported in security rules -- use `!=`.',
  },
  {
    pattern: /\?\./,
    message: "Optional chaining `?.` is not supported -- use `'field' in obj && obj.field`.",
  },
  {
    pattern: /\?\?/,
    message: 'Nullish coalescing `??` is not supported -- use a ternary `cond ? a : b`.',
  },
  {
    pattern: /=>/,
    message: 'Arrow functions `=>` are not supported -- define functions with `function name() { return ...; }`.',
  },
  {
    pattern: /`[^`]*`/,
    message: 'Backtick strings are not supported -- use single or double quoted strings with `+` for concatenation.',
  },
];
