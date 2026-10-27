/**
 * ─── r56-regex-classes-runtime ─────────────────────────────────────────────
 * The parts of RTDB's regex dialect no capture has observed yet, at runtime:
 *
 *   - what `\s` covers: space, `\t \n \v \f \r`, U+00A0, U+2003, U+3000,
 *     U+FEFF, U+2028, U+0085, U+001C, and `\S` on U+00A0;
 *   - whether `\w` and `\d` reach past ASCII (é, ٣);
 *   - how the `i` flag folds case: k/K, the Kelvin sign U+212A, é/É, a range,
 *     a negated set, and the dotless ı against I;
 *   - whether `& ~ # @ >` are plain characters or dk.brics operators
 *     (intersection, complement, the empty language, any string), each with
 *     a near miss only the operator reading accepts or refuses;
 *   - the email pattern the Zod generator emits;
 *   - `\n` as the letter n, and `(|a)` as the literal `|a`.
 *
 * pyric reads `\s` as JavaScript's whitespace set, folds case with
 * toLowerCase and toUpperCase, keeps `\w` and `\d` ASCII, and reads the five
 * characters as literals. `"` and `<` could make the whole ruleset fail to
 * deploy under the operator reading, so r57 probes them as dry runs first.
 *
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). Expectations are
 * pyric's verdicts, placeholders until the capture replaces them in
 * observations/rtdb-rules/rules-rtdb-r56-regex-classes-runtime.json.
 */
import type { RtdbScenarioRecord, RtdbTestCase } from './types.ts';

const validated = (regex: string): Record<string, string> => ({
  '.write': 'auth != null',
  '.validate': `newData.isString() && newData.val().matches(${regex})`,
});

const write = (description: string, opPath: string, newData: string, expectation: 'ALLOW' | 'DENY'): RtdbTestCase => ({
  description,
  expectation,
  operation: 'write',
  opPath,
  authPresent: true,
  newData,
});

const SPACES: Array<[string, string, 'ALLOW' | 'DENY']> = [
  ['a space', ' ', 'ALLOW'],
  ['a tab', '\t', 'ALLOW'],
  ['a line feed', '\n', 'ALLOW'],
  ['a vertical tab', '\v', 'ALLOW'],
  ['a form feed', '\f', 'ALLOW'],
  ['a carriage return', '\r', 'ALLOW'],
  ['U+00A0 no-break space', ' ', 'ALLOW'],
  ['U+2003 em space', ' ', 'ALLOW'],
  ['U+3000 ideographic space', '　', 'ALLOW'],
  ['U+FEFF byte order mark', '﻿', 'ALLOW'],
  ['U+2028 line separator', ' ', 'ALLOW'],
  ['U+0085 next line', '\u0085', 'DENY'],
  ['U+001C file separator', '\u001c', 'DENY'],
];

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pyric reads \\s as JavaScript whitespace, folds case with toLowerCase and toUpperCase, keeps \\w and \\d ASCII, and reads & ~ # @ > as plain characters; no capture has observed how production reads any of them.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Awaiting a deploy-observe-restore capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r56-regex-classes-runtime.json.',
  rules: JSON.stringify({
    space: validated('/^\\s$/'),
    nonspace: validated('/^\\S$/'),
    word: validated('/^\\w$/'),
    digit: validated('/^\\d$/'),
    k: validated('/^k$/i'),
    eacute: validated('/^é$/i'),
    range: validated('/^[a-z]$/i'),
    nota: validated('/^[^a]$/i'),
    dotless: validated('/^ı$/i'),
    amp: validated('/^a&b$/'),
    tilde: validated('/^a~b$/'),
    hash: validated('/^a#b$/'),
    at: validated('/^a@b$/'),
    gt: validated('/^a>b$/'),
    email: validated('/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/'),
    letter: validated('/^a\\nb$/'),
    emptyalt: validated('/^(|a)$/'),
  }),
  cases: [
    ...SPACES.map(([name, value, verdict]) => write(`\\s on ${name}`, '/space', value, verdict)),
    write('\\S on U+00A0 no-break space', '/nonspace', ' ', 'DENY'),
    write('\\w on é', '/word', 'é', 'DENY'),
    write('\\d on Arabic-Indic digit three', '/digit', '٣', 'DENY'),
    write('i flag: k against K', '/k', 'K', 'ALLOW'),
    write('i flag: k against the Kelvin sign U+212A', '/k', 'K', 'ALLOW'),
    write('i flag: é against É', '/eacute', 'É', 'ALLOW'),
    write('i flag: [a-z] against Q', '/range', 'Q', 'ALLOW'),
    write('i flag: [^a] against A', '/nota', 'A', 'DENY'),
    write('i flag: dotless ı against I', '/dotless', 'I', 'DENY'),
    write('& literal: a&b', '/amp', 'a&b', 'ALLOW'),
    write('& near miss: ab', '/amp', 'ab', 'DENY'),
    write('~ literal: a~b', '/tilde', 'a~b', 'ALLOW'),
    write('~ near miss: ac (complement reading accepts)', '/tilde', 'ac', 'DENY'),
    write('# literal: a#b', '/hash', 'a#b', 'ALLOW'),
    write('# near miss: ab', '/hash', 'ab', 'DENY'),
    write('@ literal: a@b', '/at', 'a@b', 'ALLOW'),
    write('@ near miss: azzb (any-string reading accepts)', '/at', 'azzb', 'DENY'),
    write('> literal: a>b', '/gt', 'a>b', 'ALLOW'),
    write('> near miss: ab', '/gt', 'ab', 'DENY'),
    write('email pattern: a@b.co', '/email', 'a@b.co', 'ALLOW'),
    write('email pattern: a@b', '/email', 'a@b', 'DENY'),
    write('email pattern: ab.co', '/email', 'ab.co', 'DENY'),
    write('\\n as the letter n: anb', '/letter', 'anb', 'ALLOW'),
    write('\\n as the letter n: a line feed between', '/letter', 'a\nb', 'DENY'),
    write('(|a) against the empty string', '/emptyalt', '', 'DENY'),
    write('(|a) against a', '/emptyalt', 'a', 'DENY'),
    write('(|a) against |a', '/emptyalt', '|a', 'ALLOW'),
  ],
};
