/**
 * Every CLI path that loads Firestore rules into a sandbox refuses a source
 * production would not load, with the reason `rulesSourceRejection` gives,
 * and keeps the rules in force: the in-process server's project rules load,
 * a seed's rules, and `rules.set`. The source a load path refused stays
 * readable to lint and simulate until other rules are installed, so a lint
 * of the loaded project still reports what is wrong with its file.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';

import { loadProjectRules } from '../../../src/bridge/server/in-process.js';
import { applyRules } from '../../../src/bridge/surface/seed-apply.js';
import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { FIRESTORE_RULES } from '../../../src/bridge/surface/rules-engines/firestore.js';
import { activeFirestoreRules } from '../../../src/bridge/surface/rules-simulation.js';
import seedMethod from '../../../src/bridge/surface/methods/sandbox/seed.js';

const IN_FORCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const UNPARSEABLE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if true }
  }
}`;

const PAST_COMPILE_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if ${'('.repeat(98)}request.auth.uid == 'a'${')'.repeat(98)}; }
  }
}`;

const REFUSED = [
  ['a source that does not parse', UNPARSEABLE],
  ['a source past a compile limit', PAST_COMPILE_LIMIT],
] as const;

function sandboxWithRulesInForce() {
  const sandbox = initializeSandbox();
  setRules(sandbox, IN_FORCE);
  return sandbox;
}

function reasonFor(source: string): string {
  return `Firestore ${rulesSourceRejection(source)!.message}`;
}

describe('the in-process server loading firestore.rules', () => {
  for (const [label, source] of REFUSED) {
    it(`refuses ${label}, keeps the rules in force, and lints the refused file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-load-'));
      try {
        writeFileSync(join(dir, 'firestore.rules'), source, 'utf8');
        const sandbox = sandboxWithRulesInForce();
        const loaded = loadProjectRules(sandbox, dir);
        expect(loaded).toEqual({ path: join(dir, 'firestore.rules'), refused: reasonFor(source) });
        expect(inspect(sandbox).rules.source).toBe(IN_FORCE);

        const ctx = createSurfaceContext(sandbox, dir);
        expect(activeFirestoreRules(ctx)).toBe(source);
        const lint = await FIRESTORE_RULES.lint(ctx, undefined);
        expect(lint.ok).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('loads a source production loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-load-'));
    try {
      writeFileSync(join(dir, 'firestore.rules'), IN_FORCE.replace('!= null', '== null'), 'utf8');
      const sandbox = sandboxWithRulesInForce();
      expect(loadProjectRules(sandbox, dir)).toEqual({ path: join(dir, 'firestore.rules'), refused: null });
      expect(inspect(sandbox).rules.source).toBe(IN_FORCE.replace('!= null', '== null'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a seed carrying Firestore rules', () => {
  for (const [label, source] of REFUSED) {
    it(`refuses ${label} and keeps the rules in force`, async () => {
      const sandbox = sandboxWithRulesInForce();
      const refusals = await applyRules(sandbox, { firestoreRules: source });
      expect(refusals).toEqual([reasonFor(source)]);
      expect(inspect(sandbox).rules.source).toBe(IN_FORCE);
      expect(activeFirestoreRules(createSurfaceContext(sandbox))).toBe(source);
    });
  }

  it('says so in the seed operation, which still seeds the data', async () => {
    const sandbox = sandboxWithRulesInForce();
    const ctx = createSurfaceContext(sandbox);
    const result = await seedMethod.handler(
      { firestoreRules: UNPARSEABLE, firestore: { 'notes/n1': { text: 'seeded' } } },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain(reasonFor(UNPARSEABLE));
    expect(inspect(sandbox).rules.source).toBe(IN_FORCE);
    expect(inspect(sandbox).documents.totalCount).toBe(1);
  });

  it('a later install replaces the refused source as the one lint and simulate read', async () => {
    const sandbox = sandboxWithRulesInForce();
    await applyRules(sandbox, { firestoreRules: UNPARSEABLE });
    const ctx = createSurfaceContext(sandbox);
    const next = IN_FORCE.replace('!= null', '== null');
    expect((await FIRESTORE_RULES.install(ctx, next)).ok).toBe(true);
    expect(activeFirestoreRules(ctx)).toBe(next);
  });
});

describe('rules.set', () => {
  for (const [label, source] of REFUSED) {
    it(`refuses ${label} with the same reason and keeps the rules in force`, async () => {
      const sandbox = sandboxWithRulesInForce();
      const ctx = createSurfaceContext(sandbox);
      const result = await FIRESTORE_RULES.install(ctx, source);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain(reasonFor(source));
      expect(inspect(sandbox).rules.source).toBe(IN_FORCE);
      // The caller holds the source it passed; the rules in force stay the ones read.
      expect(activeFirestoreRules(ctx)).toBe(IN_FORCE);
    });
  }
});
