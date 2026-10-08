import { describe, test, expect } from 'bun:test';
import { locateRtdbRule, locateRtdbTrace } from '../../../src/rules/rtdb/source-locations.js';

// Line numbers are 1-based and noted at the end of each row of the fixture.
const COMMENTED = [
  '// database.rules.json: top comment with { braces', // 1
  '{', // 2
  '  /* block comment', // 3
  '     ".read": true, fake key inside a comment */', // 4
  '  "rules": {', // 5
  '    ".read": false,', // 6
  '    // ".write": true,', // 7
  '    "rooms": {', // 8
  '      ".indexOn": ["owner", "createdAt"],', // 9
  '      "$roomId": {', // 10
  '        ".read": "auth != null", // trailing comment', // 11
  '        ".write": "data.val() == \'}\' && auth != null",', // 12
  '        ".validate": "newData.isString()",', // 13
  '        "members": {', // 14
  '          "$uid": { ".write": "$uid === auth.uid" }', // 15
  '        }', // 16
  '      }', // 17
  '    },', // 18
  '    "public": {', // 19
  '      ".read": true,', // 20
  '      ".write": false', // 21
  '    }', // 22
  '  }', // 23
  '}', // 24
].join('\n');

describe('locateRtdbRule', () => {
  test('maps each rule node of a commented ruleset to its line', () => {
    expect(locateRtdbRule(COMMENTED, '/', '.read')?.line).toBe(6);
    expect(locateRtdbRule(COMMENTED, '/rooms', '.indexOn')?.line).toBe(9);
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId', '.read')?.line).toBe(11);
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId', '.write')?.line).toBe(12);
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId', '.validate')?.line).toBe(13);
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId/members/$uid', '.write')?.line).toBe(15);
    expect(locateRtdbRule(COMMENTED, '/public', '.read')?.line).toBe(20);
    expect(locateRtdbRule(COMMENTED, '/public', '.write')?.line).toBe(21);
  });

  test('does not match keys that appear only inside comments', () => {
    expect(locateRtdbRule(COMMENTED, '/', '.write')).toBeNull();
  });

  test('reports the column of the rule key, counted from 1', () => {
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId', '.read')).toEqual({ line: 11, column: 9 });
    expect(locateRtdbRule(COMMENTED, '/rooms/$roomId/members/$uid', '.write')).toEqual({
      line: 15,
      column: 21,
    });
  });

  test('accepts a path without a leading slash and with a trailing slash', () => {
    expect(locateRtdbRule(COMMENTED, 'rooms/$roomId/', '.validate')?.line).toBe(13);
    expect(locateRtdbRule(COMMENTED, '', '.read')?.line).toBe(6);
  });

  test('returns null for a missing path, a missing kind, or unparseable text', () => {
    expect(locateRtdbRule(COMMENTED, '/nope', '.read')).toBeNull();
    expect(locateRtdbRule(COMMENTED, '/public', '.validate')).toBeNull();
    expect(locateRtdbRule('{ "rules": { ".read": ', '/', '.read')).toBeNull();
    expect(locateRtdbRule('not json', '/', '.read')).toBeNull();
  });

  test('counts CRLF and lone CR line endings as one line each', () => {
    const crlf = '{\r\n  "rules": {\r\n    ".read": true\r\n  }\r\n}';
    expect(locateRtdbRule(crlf, '/', '.read')?.line).toBe(3);
    const cr = '{\r  "rules": {\r    ".read": true\r  }\r}';
    expect(locateRtdbRule(cr, '/', '.read')?.line).toBe(3);
  });

  test('line numbers survive a multi-line block comment before the rule', () => {
    const src = '{\n"rules": {\n/* a\nb\nc */\n".write": true\n}\n}';
    expect(locateRtdbRule(src, '/', '.write')?.line).toBe(6);
  });

  test('a key-like string value is not mistaken for a rule key', () => {
    const src = '{\n"rules": {\n"a": { ".read": "\\".write\\"" ,\n".write": true }\n}\n}';
    expect(locateRtdbRule(src, '/a', '.write')?.line).toBe(4);
  });

  test('reads a rule string that spans lines and counts its line breaks', () => {
    const src = [
      '{', // 1
      '  "rules": {', // 2
      '    ".read": "auth != null', // 3
      '      && auth.uid != null",', // 4
      '    ".write": "true\r', // 5
      '      && true",', // 6
      '    ".validate": "true"', // 7
      '  }', // 8
      '}', // 9
    ].join('\n');
    expect(locateRtdbRule(src, '/', '.read')?.line).toBe(3);
    expect(locateRtdbRule(src, '/', '.write')?.line).toBe(5);
    expect(locateRtdbRule(src, '/', '.validate')?.line).toBe(7);
  });

  test('reads trailing commas in objects and arrays, before a comment too', () => {
    const src = [
      '{', // 1
      '  "rules": {', // 2
      '    "a": { ".indexOn": ["x", "y",], },', // 3
      '    "b": {', // 4
      '      ".read": "true", // last member', // 5
      '    },', // 6
      '  },', // 7
      '}', // 8
    ].join('\n');
    expect(locateRtdbRule(src, '/a', '.indexOn')?.line).toBe(3);
    expect(locateRtdbRule(src, '/b', '.read')?.line).toBe(5);
  });

  test('refuses the comma forms production refuses', () => {
    expect(locateRtdbRule('{ "rules": { ".read": true,, } }', '/', '.read')).toBeNull();
    expect(locateRtdbRule('{ "rules": { , ".read": true } }', '/', '.read')).toBeNull();
    expect(locateRtdbRule('{ "rules": { ".indexOn": [,"a"] } }', '/', '.indexOn')).toBeNull();
  });

  test('the last duplicate key wins, as JSON.parse reads it', () => {
    const src = '{\n"rules": {\n".read": false,\n".read": true\n}\n}';
    expect(locateRtdbRule(src, '/', '.read')?.line).toBe(4);
  });
});

describe('locateRtdbTrace', () => {
  const entry = (path: string, kind: 'read' | 'write' | 'validate') => ({
    path,
    kind,
    conditionText: 'true',
    verdict: 'ALLOW' as const,
    pathVariableBindings: {},
  });

  test('gives each entry the line of its rule and keeps the entry otherwise unchanged', () => {
    const trace = [
      entry('/', 'read'),
      entry('/rooms/$roomId', 'write'),
      entry('/rooms/$roomId', 'validate'),
    ];
    const located = locateRtdbTrace(COMMENTED, trace);
    expect(located.map((e) => e.line)).toEqual([6, 12, 13]);
    expect(located[1]).toEqual({ ...trace[1], line: 12 });
  });

  test('leaves the line off an entry whose rule the source does not contain', () => {
    const [located] = locateRtdbTrace(COMMENTED, [entry('/public', 'validate')]);
    expect(located).toEqual(entry('/public', 'validate'));
    expect('line' in located).toBe(false);
  });

  test('gives lines for a ruleset with a multi-line rule string and trailing commas', () => {
    const src = '{\n  "rules": {\n    ".read": "true\n      && true",\n    "a": { ".write": "true", },\n  },\n}';
    const located = locateRtdbTrace(src, [entry('/', 'read'), entry('/a', 'write')]);
    expect(located.map((e) => e.line)).toEqual([3, 5]);
  });

  test('leaves every line off when the text is not valid JSON', () => {
    const located = locateRtdbTrace('not json', [entry('/', 'read')]);
    expect('line' in located[0]).toBe(false);
  });
});
