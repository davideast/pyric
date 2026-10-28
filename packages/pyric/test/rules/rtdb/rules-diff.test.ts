import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffRtdbRules } from '../../../src/rules/index.js';
import { canonicalRtdbExpression } from '../../../src/rules/rtdb/grammar/canonical.js';
import { toStrictRulesJson } from '../../../src/rules/rtdb/rules-text.js';
import { findCounterexample } from './grammar/equivalence-harness.js';

const FIXTURES = join(import.meta.dir, 'fixtures', 'spaces-legacy-vs-compiled');
const readRules = (name: string): Record<string, unknown> =>
  JSON.parse(toStrictRulesJson(readFileSync(join(FIXTURES, name), 'utf8'))).rules;

/**
 * The rules `rtdb_inspect_rules` diffed before this option existed, by raw
 * text. Pinned so the default stays a text comparison.
 */
describe('diffRtdbRules default: rule expressions compare as text', () => {
  test('a spelling change is a change', () => {
    expect(diffRtdbRules({ a: { '.read': 'auth.uid !== null' } }, { a: { '.read': 'auth != null' } })).toEqual([
      { path: '/a', kind: '.read', change: 'changed', deployed: 'auth.uid !== null', local: 'auth != null' },
    ]);
  });

  test('a boolean and its string form are one expression; added and removed are reported', () => {
    expect(diffRtdbRules(
      { '.read': true, a: { '.write': 'false' }, b: { '.indexOn': 'x' } },
      { '.read': 'true', a: { '.write': false, '.validate': 'newData.isString()' }, b: { '.indexOn': ['x'] } },
    )).toEqual([{ path: '/a', kind: '.validate', change: 'added', local: 'newData.isString()' }]);
  });
});

describe('diffRtdbRules ignoreEquivalent', () => {
  test('equivalent spellings are not changes; a changed entry keeps both texts as written', () => {
    const deployed = { a: { '.read': 'auth.uid !== null', '.write': "auth.uid === $uid" } };
    const local = { a: { '.read': 'auth != null', '.write': "auth.uid == $other" } };
    expect(diffRtdbRules(deployed, local, { ignoreEquivalent: true })).toEqual([
      { path: '/a', kind: '.write', change: 'changed', deployed: 'auth.uid === $uid', local: 'auth.uid == $other' },
    ]);
  });

  test('an expression that does not parse compares as text', () => {
    expect(diffRtdbRules({ '.read': 'auth = 1' }, { '.read': 'auth = 1' }, { ignoreEquivalent: true })).toEqual([]);
    expect(diffRtdbRules({ '.read': 'auth = 1' }, { '.read': 'auth  = 1' }, { ignoreEquivalent: true })).toHaveLength(1);
  });

  test('.indexOn is never canonicalized', () => {
    expect(diffRtdbRules({ '.indexOn': ['a', 'b'] }, { '.indexOn': ['b', 'a'] }, { ignoreEquivalent: true })).toHaveLength(1);
  });
});

/**
 * Acceptance: the hand-written rules of google-labs-code/spaces against the
 * rules its constraints definition compiles to (fixture README names the
 * source commit). Every remaining entry is one this module declines to call
 * equivalent: `'…/members/' + auth.uid` against `.child('members').child(auth.uid)`,
 * since a concatenated `auth.uid` is not split (canonical.ts, childSegments).
 */
const DECLINED_CHAT_HISTORY = [
  { path: '/spaces_app/spaces/$spaceid/chatHistory/$tabid', kind: '.read' },
  { path: '/spaces_app/spaces/$spaceid/chatHistory/$tabid', kind: '.write' },
];

for (const [instance, rawCount] of [['main', 35], ['shard', 32]] as const) {
  describe(`spaces ${instance}: legacy rules against compiled rules`, () => {
    const legacy = readRules(`legacy-${instance}.rules.json`);
    const compiled = readRules(`compiled-${instance}.rules.json`);

    test('without the option, every respelled expression is a raw change', () => {
      const raw = diffRtdbRules(legacy, compiled);
      expect(raw).toHaveLength(rawCount);
      expect(raw.every((c) => c.change === 'changed')).toBe(true);
    });

    test('with ignoreEquivalent, only the declined auth.uid concatenation remains, with raw values', () => {
      const diff = diffRtdbRules(legacy, compiled, { ignoreEquivalent: true });
      expect(diff.map(({ path, kind }) => ({ path, kind }))).toEqual(DECLINED_CHAT_HISTORY);
      for (const entry of diff) {
        expect(entry.deployed).toContain("'/members/' + auth.uid");
        expect(entry.local).toContain(".child('members').child(auth.uid)");
      }
    });

    test('every pair called equivalent decides alike through the simulator', () => {
      const raw = diffRtdbRules(legacy, compiled);
      const equivalent = raw.filter((c) => canonicalRtdbExpression(c.deployed!) === canonicalRtdbExpression(c.local!));
      expect(equivalent).toHaveLength(rawCount - 2);
      for (const [i, c] of equivalent.entries()) {
        const counterexample = findCounterexample(c.deployed!, c.local!, { count: 80, seed: i + 1 });
        if (counterexample) throw new Error(`${c.path} ${c.kind} decides differently: ${JSON.stringify(counterexample)}`);
      }
    }, 60_000);

    test('dropping the removed check from one compiled .read is reported at exactly that path', () => {
      const mutated = structuredClone(compiled) as any;
      const node = mutated.spaces_app.spaces.$spaceid.log;
      const removedCheck = " && !(root.child('spaces_app').child('spaces').child($spaceid).child('metadata').child('members').child(auth.uid).child('removed').val() == true)";
      expect(node['.read']).toContain(removedCheck);
      node['.read'] = node['.read'].replace(removedCheck, '');
      const diff = diffRtdbRules(legacy, mutated, { ignoreEquivalent: true });
      expect(diff.map(({ path, kind }) => ({ path, kind }))).toEqual([
        ...DECLINED_CHAT_HISTORY,
        { path: '/spaces_app/spaces/$spaceid/log', kind: '.read' },
      ]);
    });

    test("changing the admin check to a member check is reported at exactly that path", () => {
      const mutated = structuredClone(compiled) as any;
      const node = mutated.spaces_app.spaces.$spaceid.metadata.anyoneCanJoin;
      expect(node['.write']).toContain("== 'admin'");
      node['.write'] = node['.write'].replace("== 'admin'", "== 'member'");
      const diff = diffRtdbRules(legacy, mutated, { ignoreEquivalent: true });
      expect(diff.map(({ path, kind }) => ({ path, kind }))).toEqual([
        { path: '/spaces_app/spaces/$spaceid/chatHistory/$tabid', kind: '.read' },
        { path: '/spaces_app/spaces/$spaceid/chatHistory/$tabid', kind: '.write' },
        { path: '/spaces_app/spaces/$spaceid/metadata/anyoneCanJoin', kind: '.write' },
      ]);
    });
  });
}
