/**
 * ─── r63-ancestor-write-data-newdata ─────────────────────────────────────────
 * Question: when a `.write` rule on an ANCESTOR of the written path reads
 * `data` / `newData`, which values does production bind? Documented semantics:
 * `data` = the stored value at the rule's location; `newData` = the merged
 * post-write value at the rule's location (stored tree with the write applied).
 *
 * Captured 2026-11-07 with deploy-observe-restore in
 * observations/rtdb-rules/rules-rtdb-r63-ancestor-write-data-newdata.json:
 * production binds `data` to the pre-write subtree and `newData` to the merged
 * post-write subtree at the ancestor rule's location across deep set, leaf
 * delete, create, deep create without required sibling, speaker rewrite, and
 * multi-path update.
 */
import type { RtdbScenarioRecord } from './types.ts';

const ownerSeed = {
  '/msgs/m1': { speaker: { uid: '<UID>' }, content: { text: 'hi' } },
};

const otherOwnerSeed = {
  '/msgs/m1': { speaker: { uid: 'alice' }, content: { text: 'hi' } },
};

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pins data/newData binding for ancestor .write rules under descendant writes (set, deep set, update, delete, create).',
  provenance:
    'Authored to verify ancestor .write rule-location data/newData binding (#2451). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-11-07 in observations/rtdb-rules/rules-rtdb-r63-ancestor-write-data-newdata.json.',
  rules: JSON.stringify({
    msgs: {
      $m: {
        '.write':
          "auth != null && (!data.exists() ? newData.child('speaker').child('uid').val() == auth.uid : data.child('speaker').child('uid').val() == auth.uid)",
        content: {
          '.write': "auth != null && data.parent().child('speaker/uid').val() == auth.uid",
        },
      },
    },
  }),
  cases: [
    {
      description: 'owner deep-writes content (newData at $m is merged: speaker kept)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/msgs/m1/content',
      authPresent: true,
      seed: ownerSeed,
      newData: { text: 'edit' },
    },
    {
      description: 'non-owner deep-writes content',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/msgs/m1/content',
      authPresent: true,
      seed: otherOwnerSeed,
      newData: { text: 'x' },
    },
    {
      description: 'non-owner rewrites speaker/uid to self (data at $m is pre-write)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/msgs/m1/speaker/uid',
      authPresent: true,
      seed: otherOwnerSeed,
      newData: '<UID>',
    },
    {
      description: 'owner leaf-deletes content text',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/msgs/m1/content/text',
      authPresent: true,
      seed: ownerSeed,
      newData: null,
    },
    {
      description: 'create with own speaker (data absent, newData merged)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/msgs/m2',
      authPresent: true,
      seed: otherOwnerSeed,
      newData: { speaker: { uid: '<UID>' }, content: { text: 'x' } },
    },
    {
      description: 'create deep content only under a new id (newData at $m lacks speaker)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/msgs/m3/content',
      authPresent: true,
      seed: otherOwnerSeed,
      newData: { text: 'x' },
    },
    {
      description: 'multi-path update touching m1/content from /msgs',
      expectation: 'DENY',
      operation: 'update',
      opPath: '/msgs',
      authPresent: true,
      seed: otherOwnerSeed,
      newData: { 'm1/content/text': 'x' },
    },
  ],
};
