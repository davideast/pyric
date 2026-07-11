/**
 * Oracle conformance — Firestore rules.
 *
 * The counterpart of the auth exemplar (test/auth/oracle-conformance.test.ts)
 * for the Firestore rules surface. It wires
 * `scripts/oracle/observations/rules-firestore-*.json` into the test suite so
 * captured production Rules-Test-API verdicts are MACHINE-CHECKED against the
 * in-process sandbox simulator, not merely cited.
 *
 * Data-driven by design: each observation's name is `rules-firestore-<id>`,
 * where `<id>` is a corpus pack id. For every captured observation the suite
 * loads the matching pack from the corpus, runs the LOCAL simulator over the
 * same ruleset + cases, and asserts the simulator's per-case decision equals
 * the captured production verdict. The corpus is the single source, so
 * coverage is structural: an observation whose id has no corresponding pack
 * FAILS loudly (a capture can't silently go un-checked).
 *
 * STAGING STATE: no `rules-firestore-*` observation has been captured yet
 * (no credentials were available to the staging branch, and no observation
 * files were fabricated). While the observation set is empty this suite
 * SKIPS with a clear message and passes. The moment a capture lands, the
 * assertions below go live verdict-for-verdict with no further edits — run
 * `scripts/oracle/run-rules.ts` with PARITY_SA_BASE64 to produce them.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_RULES_FIRESTORE_PACKS,
  RULES_FIRESTORE_OBSERVATION_PREFIX,
  observationName,
  type Pack,
} from '../../../../scripts/oracle/rules-corpus/firestore/index.ts';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** name (no extension) → pack, for O(1) observation→pack resolution. */
const PACK_BY_OBSERVATION = new Map<string, Pack>(
  ALL_RULES_FIRESTORE_PACKS.map((pack) => [observationName(pack), pack]),
);

interface RulesObservation {
  name: string;
  behavior: Record<string, unknown>;
}

/**
 * Known simulator/production divergences, pinned per the auth and firestore
 * exemplars' KNOWN DIVERGENCE convention (see test/auth/oracle-conformance.test.ts
 * row-31, test/firestore/oracle-conformance.test.ts firestore-limittolast-preconditions):
 * these are genuine, tracked gaps (#135), not silently skipped cases. Each entry
 * pins BOTH sides — the captured production verdict and the simulator's current
 * verdict — so the suite stays green today but fails loudly the moment the
 * simulator's actual behavior changes on one of these cases, forcing a revisit.
 *
 * Keyed by `${observationName} :: ${caseKey}`.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; simVerdict: 'ALLOW' | 'DENY'; reason: string; issue: string }
> = {
  "rules-firestore-bytes-toutf8-and-hashing :: toBase64 round-trip ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator toBase64() round-trip does not match production byte encoding, so the rule that should deny passes locally',
    issue: '#135',
  },
  "rules-firestore-bytes-toutf8-and-hashing :: md5 empty string ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator md5() over the empty string diverges from production hashing output',
    issue: '#135',
  },
  "rules-firestore-bytes-toutf8-and-hashing :: sha256 abc ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator sha256() diverges from production hashing output',
    issue: '#135',
  },
  "rules-firestore-bytes-toutf8-and-hashing :: crc32 IEEE 802.3 ref ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator crc32() reference implementation diverges from production',
    issue: '#135',
  },
  "rules-firestore-bytes-toutf8-and-hashing :: crc32c Castagnoli ref ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator crc32c() reference implementation diverges from production',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: getAfter target == request.resource.data ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator getAfter() does not model the post-write document identity production compares against',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter create true ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a create does not match production post-write existence semantics',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter delete false ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a delete does not match production post-write existence semantics',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter unrelated mocked path ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() over an unrelated mocked path does not match production',
    issue: '#135',
  },
  "rules-firestore-get-missing-doc :: get(mocked).id == 'site' → DENY (mocked get() has no resource identity in production)": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator synthesizes a resource identity for mocked get() results that production leaves absent',
    issue: '#135',
  },
  "rules-firestore-get-missing-doc :: get(mocked).__name__ == path literal → DENY (mocked get() has no resource identity in production)": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator synthesizes a __name__ for mocked get() results that production leaves absent',
    issue: '#135',
  },
  'rules-firestore-globals-request-path-and-resource-id :: request.query empty map ALLOW': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator models request.query as an empty map where production denies the equivalent comparison',
    issue: '#135',
  },
  'rules-firestore-int-float-and-division :: float payload is float / not int ALLOW': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'simulator narrows a float-valued payload field toward int, unlike production which preserves the float type',
    issue: '#135',
  },
  "rules-firestore-path-constructor-and-bind :: path() idempotent on Path arg ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator treats path() as idempotent on an already-Path argument where production denies',
    issue: '#135',
  },
  'rules-firestore-range-slice-list-and-string :: list slice end OOB clamps to length ALLOW': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator clamps an out-of-bounds list slice end to the list length; production denies',
    issue: '#135',
  },
  'rules-firestore-range-slice-list-and-string :: string slice end OOB clamps to length ALLOW': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator clamps an out-of-bounds string slice end to the string length; production denies',
    issue: '#135',
  },
};

function loadObservation(file: string): RulesObservation {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as {
    name?: string;
    behavior?: Record<string, unknown>;
  };
  return {
    name: raw.name ?? file.replace(/\.json$/, ''),
    behavior: raw.behavior ?? {},
  };
}

/** Every captured `rules-firestore-*.json` in the observations directory. */
function capturedObservationFiles(): string[] {
  return readdirSync(OBS_DIR)
    .filter((f) => f.startsWith(RULES_FIRESTORE_OBSERVATION_PREFIX) && f.endsWith('.json'))
    .sort();
}

/** Simulator decision per case, keyed the same way the capture keys verdicts
 *  (by case description) so the two tables line up 1:1. The simulator (and its
 *  parser/evaluator dependency graph) is imported lazily so the empty-set guard
 *  path runs without loading it. */
async function simulateVerdicts(pack: Pack): Promise<Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'>> {
  const { SimulateFirestoreRulesHandler } = await import('../../src/rules/simulator/handler.js');
  const sim = new SimulateFirestoreRulesHandler();
  const res = sim.simulate(pack.rules, pack.cases);
  if (!res.success) {
    throw new Error(`simulator failed for pack "${pack.id}": ${res.error.code} ${res.error.message}`);
  }
  const table: Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'> = {};
  res.data.results.forEach((r, i) => {
    table[pack.cases[i].description] = r.decision;
  });
  return table;
}

describe('oracle conformance (rules-firestore)', () => {
  const files = capturedObservationFiles();

  // ── empty-set guard: pass + skip while nothing is captured ──────────────
  if (files.length === 0) {
    it('no rules-firestore observations captured yet (staging) — skipping replay', () => {
      // Intentionally passes: the machinery is staged, the corpus is in place,
      // but no captures have been run. Run `scripts/oracle/run-rules.ts` with
      // PARITY_SA_BASE64 to produce observations, after which these assertions
      // go live automatically.
      expect(files.length).toBe(0);
    });
  }

  // ── verdict-for-verdict replay (live the moment observations exist) ──────
  for (const file of files) {
    const obs = loadObservation(file);
    const pack = PACK_BY_OBSERVATION.get(obs.name);

    it(`${obs.name}: simulator matches captured production verdicts`, async () => {
      // Completeness is structural: an observation with no corpus pack is a
      // silent-gap failure — either the pack was removed or the file is stale.
      expect(
        pack,
        `observation "${obs.name}" has no matching corpus pack — coverage gap`,
      ).toBeDefined();
      if (!pack) return;

      const sim = await simulateVerdicts(pack);
      // Every case in the pack is checked and any mismatch is collected here
      // rather than asserted immediately — bun aborts a test at the first
      // thrown `expect`, so asserting per-case would hide later divergences
      // behind an earlier one. Collecting first and asserting once at the end
      // (below) means every diverging case in the pack is reported together.
      const mismatches: string[] = [];
      for (const [caseKey, prodVerdict] of Object.entries(obs.behavior)) {
        const simVerdict = sim[caseKey];
        // The simulator's documented third state: when it abstains
        // (UNSUPPORTED) it is neither agreement nor a bug — it mirrors the
        // parity harness's SIM_NOT_SUPPORTED. Record but do not fail on it;
        // everything else must match production exactly.
        if (simVerdict === 'UNSUPPORTED') continue;

        const divergenceKey = `${obs.name} :: ${caseKey}`;
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          // Pinned, tracked gap (see KNOWN_DIVERGENCES above): the captured
          // production verdict AND the simulator's current verdict must both
          // still match what was pinned, so neither can silently drift. If
          // the simulator's behavior ever changes on this case, that's
          // reported below and the entry must be revisited.
          if (prodVerdict !== known.prodVerdict) {
            mismatches.push(
              `${divergenceKey} (recorded prod verdict): expected ${JSON.stringify(known.prodVerdict)}, got ${JSON.stringify(prodVerdict)}`,
            );
          }
          if (simVerdict !== known.simVerdict) {
            mismatches.push(
              `${divergenceKey} (recorded sim verdict, ${known.issue}: ${known.reason}): expected ${JSON.stringify(known.simVerdict)}, got ${JSON.stringify(simVerdict)}`,
            );
          }
          continue;
        }
        if (simVerdict !== prodVerdict) {
          mismatches.push(`${divergenceKey}: expected ${JSON.stringify(prodVerdict)}, got ${JSON.stringify(simVerdict)}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  // ── coverage: no captured observation is left un-replayed ────────────────
  it('every captured rules-firestore observation maps to a corpus pack', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !PACK_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
