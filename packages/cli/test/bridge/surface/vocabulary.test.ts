/**
 * The vocabulary invariant: every service-tool method name is the SDK's own
 * or pyric's own, never invented. `firebase-js.json` and `firebase-admin.json`
 * are generated from the installed SDKs' type declarations
 * (`scripts/generate-sdk-names.ts`); `pyric.json` is authored by hand.
 */
import { describe, expect, it } from 'bun:test';

import { TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import firebaseAdmin from '../../../src/bridge/surface/sdk-names/firebase-admin.json' with { type: 'json' };
import firebaseJs from '../../../src/bridge/surface/sdk-names/firebase-js.json' with { type: 'json' };
import pyric from '../../../src/bridge/surface/sdk-names/pyric.json' with { type: 'json' };

type NamesByService = Record<string, string[]>;

const FIREBASE_JS = firebaseJs as NamesByService;
const FIREBASE_ADMIN = firebaseAdmin as NamesByService;
const PYRIC = new Set(pyric as string[]);

/**
 * The list a method's declared origin is checked against, scoped to its own
 * tool (service) for the two SDKs and flat for pyric's own names. Scoping the
 * SDK lists per service, rather than checking global uniqueness across every
 * tool, is deliberate: a name such as `set` is a real Realtime Database
 * export and, on a different tool, a legitimate pyric method name
 * (`rules.set`), and the two are not the same claim.
 */
function listFor(origin: string, toolName: string): readonly string[] {
  if (origin === 'firebase-js') return FIREBASE_JS[toolName] ?? [];
  if (origin === 'firebase-admin') return FIREBASE_ADMIN[toolName] ?? [];
  return [...PYRIC];
}

describe('the service-tool vocabulary', () => {
  for (const tool of TOOLS) {
    for (const method of tool.methods) {
      it(`${tool.name}.${method.method} is a real ${method.sdkOrigin} name`, () => {
        const list = listFor(method.sdkOrigin, tool.name);
        expect(list).toContain(method.method);
      });
    }
  }

  it('names every method exactly once in the list its own origin points at', () => {
    for (const tool of TOOLS) {
      for (const method of tool.methods) {
        const own = listFor(method.sdkOrigin, tool.name);
        expect(own.filter((name) => name === method.method)).toHaveLength(1);
      }
    }
  });

  /**
   * The two generated lists are written sorted. `pyric.json` is authored by
   * hand and has to match, or a name appended at the end is invisible to a
   * reader looking for it and every future addition conflicts on the same
   * line.
   */
  it('keeps the hand-authored pyric list sorted', () => {
    const names = pyric as string[];
    expect(names).toEqual([...names].sort());
  });
});
