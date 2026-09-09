/**
 * The validator-quality invariant: every message the `sdk-service` validator
 * produces names the tool, names the method, quotes the offending value, and
 * gives a fix as a sentence that opens with an imperative verb. These are the
 * same calls `sdk-service.test.ts` exercises for their exact wording; this
 * file checks the shape every one of them must have, so a new validator
 * message is held to the same bar without repeating its exact text here.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

/** Imperative verbs this codebase's fix sentences open with. */
const FIX_VERBS = ['Pass', 'Use', 'Call', 'Add', 'Remove', 'Rename'];

const surface = renderSurface('sdk-service');

function callWith(ctx: SurfaceContext) {
  return async (
    tool: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<OperationResult> => {
    const rendered = surface.tools.find((candidate) => candidate.name === tool);
    if (!rendered) throw new Error(`no rendered tool named ${tool}`);
    return rendered.execute({ method, args }, ctx);
  };
}

const call = callWith(createSurfaceContext(initializeSandbox()));

/** The same calls `sdk-service.test.ts` exercises for their exact wording. */
const REJECTIONS: Array<[string, string, Record<string, unknown>]> = [
  ['firestore', 'setDocument', { path: 'users/alice' }],
  ['firestore', 'setDoc', { path: 'users', data: { role: 'admin' } }],
  ['firestore', 'addDoc', { path: 'users/alice', data: { role: 'admin' } }],
  ['auth', 'setCustomUserClaims', { uid: 'alice', claims: { role: 'admin' } }],
  ['sandbox', 'reset', {}],
  ['database', 'set', { path: 'rooms/lobby.name', value: 1 }],
  ['storage', 'uploadBytes', { path: 'uploads/hello.txt', contentBase64: 'not base64!!' }],
  ['auth', 'createUser', { uid: 'alice', email: 'alice' }],
  ['auth', 'createUser', { uid: 'alice', password: 'abc12' }],
  ['rules', 'lint', { service: 'firestone' }],
  [
    'firestore',
    'getDocs',
    {
      path: 'users',
      constraints: [
        { type: 'where', field: 'age', op: '>', value: 21 },
        { type: 'orderBy', field: 'name' },
      ],
    },
  ],
  ['firestore', 'getDocs', { path: 'users', constraints: [{ type: 'where', field: 'role', op: '=', value: 'admin' }] }],
  ['rules', 'explainDenial', { service: 'storage', operation: 'get', path: 'uploads/hello.txt' }],
  ['rules', 'set', { service: 'firestore', rules: 'not rules at all {' }],
  ['sandbox', 'checkpoint', { name: '../evil' }],
  ['assurance', 'replaySession', { service: 'firestone' }],
  ['assurance', 'replaySession', { sessionPath: '../elsewhere.json' }],
  ['assurance', 'verifyCases', { service: 'database' }],
  ['assurance', 'verifyCases', { fixture: '../elsewhere.json' }],
  ['assurance', 'canIUse', { feature: '' }],
  ['assurance', 'inspect', { campaignId: 'first-pass', probe: 'probe-1' }],
  ['assurance', 'export', { campaignId: 'first-pass', path: '../elsewhere.json' }],
  ['assurance', 'testRulesHosted', { service: 'firestone', rules: 'x', cases: [{}] }],
];

/** The rejections whose message must quote the value the caller sent. */
const QUOTED_VALUES: Array<[string, string, Record<string, unknown>, string]> = [
  ['sandbox', 'checkpoint', { name: '../evil' }, "'../evil'"],
  [
    'assurance',
    'replaySession',
    { sessionPath: '../elsewhere.json' },
    "'../elsewhere.json'",
  ],
];

describe('a rejection quotes the value it refused', () => {
  for (const [tool, method, args, quoted] of QUOTED_VALUES) {
    it(`${tool}.${method} names ${quoted} rather than calling it missing`, async () => {
      const result = await call(tool, method, args);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain(quoted);
      expect(result.summary).not.toContain('missing');
    });
  }
});

describe('validator message quality', () => {
  for (const [tool, method, args] of REJECTIONS) {
    it(`${tool}.${method}'s rejection names the tool, the method, and a verb-first fix`, async () => {
      const result = await call(tool, method, args);
      expect(result.ok).toBe(false);
      const data = result.data as { tool: string; method: string; fix: string };

      expect(result.summary).toContain(tool);
      expect(result.summary).toContain(`${tool}.${data.method}:`);
      expect(data.fix.length).toBeGreaterThan(0);
      expect(result.summary).toContain(data.fix);

      const opensWithVerb = FIX_VERBS.some((verb) => data.fix.startsWith(verb));
      expect(opensWithVerb).toBe(true);
    });
  }
});
