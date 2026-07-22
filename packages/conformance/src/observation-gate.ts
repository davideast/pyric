/**
 * Shared observation completeness gate for the oracle-conformance suites.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Before this helper, every surface's completeness test asked only whether each
 * committed observation's filename appeared as a SUBSTRING of the test file's own
 * source text (`source.includes(f.replace('.json',''))`). A filename sitting in a
 * comment satisfied that check, and nothing verified the observation's recorded
 * behavior fields were ever driven against the mirror. The messaging suites did
 * not scan the observations directory at all — they gated only on a row partition
 * — so the committed `messaging-*` captures were wholly unguarded despite cdd.md
 * step 3 claiming prefix completeness.
 *
 * ─── MECHANISM: an instrumented loader ──────────────────────────────────────
 * `load(name)` returns the observation's `behavior` block wrapped in a `Proxy`
 * whose get-trap records every top-level field read, keyed to that observation
 * file. `report()` then requires each committed observation under the prefix to
 * be EITHER listed in `notApplicable` (with a written reason) OR loaded AND have
 * had at least one behavior field read at runtime. Consequences:
 *   - A filename mentioned only in a comment is never loaded  → uncovered → fail.
 *   - A bare `load(name)` whose result is never read (zero field reads) is
 *     `loadedButUnused` → uncovered → fail.
 * This is strictly stronger than the old substring gate: a comment or an unused
 * `load()` no longer passes.
 *
 * ─── CROSS-FILE ASSERTIONS (`siblingSources`) ───────────────────────────────
 * A surface may split its assertions across sibling test files (rtdb-modular
 * asserts its `onDisconnect` captures in `on-disconnect.test.ts`). Runtime
 * instrumentation cannot see a sibling's `load()` calls, so `report()` falls back
 * to a STATIC check for any committed observation not loaded in-process: it counts
 * the observation covered only if a sibling source contains an actual
 * `load('<stem>')` / `obs('<stem>')` CALL for it (`assertedInSibling`). A bare
 * comment mention in the sibling — the exact hole this gate closes in-file — does
 * NOT satisfy it. This is a documented, weaker tier than in-file instrumentation:
 * it proves the sibling loads the observation, not that the loaded value reaches
 * an assertion (see limit 5).
 *
 * ─── HONEST LIMITS (read before trusting the green) ─────────────────────────
 *  1. In-file, it records that a field was READ, not that the read value reached
 *     an `expect()`. A handler that reads `o.foo` into a variable and never
 *     asserts it still marks the file asserted. The gate proves the observation's
 *     data flowed into the suite, not that every field's comparison outcome is
 *     checked — full data-flow-to-assertion tracking is out of scope.
 *  2. Only top-level `behavior` keys are tracked. A deep read
 *     (`o.routing.visibleClient`) counts via its top-level parent (`routing`);
 *     the gate does not require every nested leaf to be touched.
 *  3. It relies on `report()` running AFTER every assertion set in the same
 *     process — call it from a single `it(...)` declared last in the file, so
 *     bun's in-file sequential execution has populated the read log by then.
 *  4. An observation whose `behavior` block is empty (`{}`) can never be marked
 *     asserted by a field read; such a capture must be listed in `notApplicable`.
 *  5. `siblingSources` matching is static (a `load(`/`obs(` call for the stem),
 *     not runtime — the gate trusts that the sibling suite, which runs in the
 *     same CI, actually drives what it loads. It is stricter than the old
 *     substring gate (a comment no longer counts) but weaker than instrumentation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ObservationGateConfig {
  /** Absolute path to the surface's observation directory. */
  dir: string;
  /**
   * Selects which files in `dir` belong to this surface's prefix. Receives the
   * bare filename (e.g. `rtdb-set-then-get-roundtrip.json`).
   */
  match: (filename: string) => boolean;
  /**
   * Observations genuinely not replayable in-process, each mapped to a written
   * reason. Keys may be given with or without the `.json` suffix.
   */
  notApplicable?: Record<string, string>;
  /**
   * Absolute paths to sibling test files that assert observations under this
   * prefix. An observation not loaded in-process is still counted covered if a
   * sibling source contains a `load('<stem>')` / `obs('<stem>')` call for it.
   */
  siblingSources?: string[];
}

export interface ObservationGateReport {
  /** All committed observation stems under the prefix (no `.json`). */
  committed: string[];
  /** Committed stems that were loaded in-process AND had ≥1 behavior field read. */
  asserted: string[];
  /** Committed stems loaded (via a `load`/`obs` call) by a sibling source. */
  assertedInSibling: string[];
  /** Stems in `notApplicable`, intersected with what is committed. */
  notApplicable: string[];
  /** Stems that were `load()`-ed in-process but had zero behavior fields read. */
  loadedButUnused: string[];
  /**
   * Committed stems that are neither asserted (here or in a sibling) nor listed
   * N/A — the gate-failing set. Includes never-loaded comment-only mentions and
   * loadedButUnused.
   */
  uncovered: string[];
}

export interface ObservationGate {
  /**
   * Instrumented loader. Returns the observation's `behavior` block wrapped so
   * every top-level field read is recorded against `name`. Accepts a name with
   * or without the `.json` suffix. Use it exactly where the suite loads an
   * observation to drive assertions.
   */
  load<T = Record<string, any>>(name: string): T;
  /** Compute the completeness report. Call from a single `it()` declared last. */
  report(): ObservationGateReport;
}

const stem = (name: string): string => (name.endsWith('.json') ? name.slice(0, -5) : name);

/** True if `source` contains an actual `load('<stem>')` / `obs('<stem>')` call
 *  (single/double/back-quoted, with or without a `.json` suffix). A bare comment
 *  mention of the stem does NOT match. */
function siblingLoadsStem(source: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:load|obs)\\(\\s*['"\`]${esc}(?:\\.json)?['"\`]`);
  return re.test(source);
}

export function createObservationGate(config: ObservationGateConfig): ObservationGate {
  const naStems = new Set(Object.keys(config.notApplicable ?? {}).map(stem));
  /** stem → set of top-level behavior keys read through the proxy. */
  const reads = new Map<string, Set<string>>();

  function record(name: string, key: string): void {
    let set = reads.get(name);
    if (!set) {
      set = new Set<string>();
      reads.set(name, set);
    }
    set.add(key);
  }

  function load<T = Record<string, any>>(name: string): T {
    const id = stem(name);
    // Registering an empty read-set marks the file loaded even before any field
    // read, so a bare load() surfaces as loadedButUnused rather than never-loaded.
    if (!reads.has(id)) reads.set(id, new Set<string>());
    const json = JSON.parse(readFileSync(join(config.dir, `${id}.json`), 'utf8')) as {
      behavior: Record<string, any>;
    };
    const behavior = json.behavior ?? {};
    return new Proxy(behavior, {
      get(target, prop, receiver) {
        // Only count real string-keyed data reads. Symbols (Symbol.iterator,
        // then/toJSON probes from test frameworks) never mark a file asserted.
        if (typeof prop === 'string' && prop in target) {
          record(id, prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as T;
  }

  function report(): ObservationGateReport {
    const committed = readdirSync(config.dir)
      .filter((f) => f.endsWith('.json') && config.match(f))
      .map(stem)
      .sort();

    const siblingText =
      (config.siblingSources ?? []).map((p) => readFileSync(p, 'utf8')).join('\n') || '';

    const asserted: string[] = [];
    const assertedInSibling: string[] = [];
    const loadedButUnused: string[] = [];
    const notApplicable: string[] = [];
    const uncovered: string[] = [];

    for (const id of committed) {
      if (naStems.has(id)) {
        notApplicable.push(id);
        continue;
      }
      const fields = reads.get(id);
      if (fields && fields.size > 0) {
        asserted.push(id);
      } else if (!fields && siblingText && siblingLoadsStem(siblingText, id)) {
        // Not loaded in-process, but a sibling suite loads it with a real call.
        assertedInSibling.push(id);
      } else {
        if (fields) loadedButUnused.push(id); // loaded in-process, but zero field reads
        uncovered.push(id);
      }
    }

    return { committed, asserted, assertedInSibling, notApplicable, loadedButUnused, uncovered };
  }

  return { load, report };
}
