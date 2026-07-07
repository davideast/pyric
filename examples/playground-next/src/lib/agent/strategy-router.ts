/**
 * Strategy router (Track C, phase C2) — classifies the submitted prompt and
 * picks the agent loop: `draft-validate` for build/modify-shaped work that
 * touches data/security (where the epic proved ~12.6× better
 * cost-per-correct at equal correctness), `react` for questions, debugging,
 * and pure-UI work.
 *
 * Binding constraints (plans/agent-capability-epic/00-autonomous-plan.md §C2):
 *   - Pure heuristic, NO LLM call.
 *   - An explicit settings override always wins (`strategyMode` 'react' or
 *     'draft-validate'); the router only acts under 'auto'.
 *   - Escalation is bounded to ONE per user prompt and carries the draft +
 *     validation failures as context.
 *
 * The routed wrapper is itself an `AgentStrategy`, so both the browser
 * session host and the headless harness consume routing + escalation through
 * the ordinary strategy seam — no host-specific orchestration forks.
 */
import type {
  AgentStrategy,
  StrategyEvent,
  StrategyRunInput,
} from '@inbrowser/agent';
import { parseRules } from './strategies/draft-then-validate';
import type { AgentPromptProfile, SkillStrategyPreference } from '~/lib/skills/registry';

// ─── Classification ──────────────────────────────────────────────────

export type RoutedStrategyName = 'draft-validate' | 'react';

export interface RouteDecision {
  strategy: RoutedStrategyName;
  source: 'override' | 'heuristic';
  /** Human-readable trigger, e.g. `build-intent "build" + data/security signal "only their own"`. */
  reason: string;
}

/** Polite-request preamble — stripped before classification so
 *  "Can you build me a tasks app…" classifies by its build verb, not by
 *  the interrogative opener. */
const POLITE_PREFIX_RE = /^\s*(please[,\s]+)?(can|could|would|will)\s+you\s+(please\s+)?/i;

/** Anchored interrogative / explain openers → react. Wins over build verbs
 *  appearing later in the sentence ("Why is my WRITE denied?"). */
const START_QUESTION_RE =
  /^\s*(why|how|what|when|where|which|who|does|do|did|is|are|was|were|should|explain|tell me|help me understand)\b/i;

/** Inline debugging phrases → react, unless a build verb signals a work
 *  request ("debug" alone is a question; "fix the rule" is work). */
const INLINE_DEBUG_RE =
  /\b(explain|why is|why does|why am|what's wrong|whats wrong|debug|investigate|look into|diagnose|figure out)\b/i;

/** Build/modify intent verbs (imperative work requests). */
const BUILD_RE =
  /\b(build|create|make|write|add|implement|set ?up|scaffold|generate|update|change|modify|fix|refactor|extend|rework|redesign|convert|secure|lock ?down|restrict|tighten|harden|allow|deny|protect|enforce|require)\b/i;

/** Data/security domain signals — the territory where draft-validate's
 *  rules-shaped draft + host validation is the right tool. */
const DATA_SECURITY_RE =
  /\b(rule|rules|security|permission|access|auth|authenticated|signed[- ]?in|sign[- ]?in|logged[- ]?in|owner|admin|claim|uid|users?|account|private|public|read[- ]?only|firestore|collection|document|database|data|store|save|seed|field|schema|deny|denied|allow|(their|his|her) own|per[- ]user)\b/i;

/**
 * Classify a prompt. Precedence (after stripping a polite "can you…" preamble):
 *   1. anchored interrogative/explain opener → react
 *   2. inline debug phrase with no build verb → react
 *   3. build/modify-shaped + data/security signal → draft-validate
 *   4. everything else (pure-UI builds, ambiguous chatter) → react
 *
 * The conservative default is react: draft-validate's draft instructions are
 * rules-shaped, so routing a prompt with no data/security surface to it
 * would produce a ruleset nobody asked for.
 */
export function routePrompt(
  prompt: string,
  opts: {
    promptProfile?: AgentPromptProfile;
    strategyPreference?: SkillStrategyPreference;
  } = {},
): RouteDecision {
  if (opts.promptProfile === 'firebase-tooling') {
    return {
      strategy: 'react',
      source: 'heuristic',
      reason: 'firebase-tooling skill active',
    };
  }
  if (opts.strategyPreference && opts.strategyPreference !== 'auto') {
    return {
      strategy: opts.strategyPreference,
      source: 'heuristic',
      reason: `active skill prefers ${opts.strategyPreference}`,
    };
  }
  let p = prompt.trim();
  const polite = POLITE_PREFIX_RE.exec(p);
  if (polite) p = p.slice(polite[0].length);

  const startQ = START_QUESTION_RE.exec(p);
  if (startQ) {
    return {
      strategy: 'react',
      source: 'heuristic',
      reason: `question/debug-shaped ("${startQ[0].trim()}…")`,
    };
  }
  const build = BUILD_RE.exec(p);
  const inlineQ = INLINE_DEBUG_RE.exec(p);
  if (inlineQ && !build) {
    return {
      strategy: 'react',
      source: 'heuristic',
      reason: `question/debug-shaped ("${inlineQ[0].trim()}")`,
    };
  }
  if (build) {
    const data = DATA_SECURITY_RE.exec(p);
    if (data) {
      return {
        strategy: 'draft-validate',
        source: 'heuristic',
        reason: `build-intent "${build[0]}" + data/security signal "${data[0]}"`,
      };
    }
    return {
      strategy: 'react',
      source: 'heuristic',
      reason: `build-intent "${build[0]}" without data/security signal (pure-UI/general)`,
    };
  }
  return { strategy: 'react', source: 'heuristic', reason: 'no build intent detected' };
}

// ─── Provenance (SF-S0a) ─────────────────────────────────────────────

/** WHY the strategy that ran was chosen. Mirrors the trace store's
 *  `StrategySource`; kept here so the router owns the mapping and both the
 *  browser host and the headless ledgers interpret events identically.
 *   - `user-selected` ← router `source:'override'` (settings strategyMode)
 *   - `routed`        ← router `source:'heuristic'` (auto-mode classifier)
 *   - `escalated`     ← the bounded draft-validate→react escalation fired */
export type StrategySource = 'user-selected' | 'routed' | 'escalated';

/** The resolved strategy + why, derived from router events. */
export interface ResolvedProvenance {
  /** The strategy actually run (the escalation target when escalated). */
  strategy: string;
  strategySource: StrategySource;
  /** Router reason for 'routed'/'escalated'; undefined for 'user-selected'. */
  reason?: string;
}

/**
 * Interpret a `strategy_routed` custom-event payload into provenance.
 * `source:'override'` → 'user-selected' (the reason is just the settings
 * knob, carrying no diagnostic signal, so it's dropped); `source:'heuristic'`
 * → 'routed' with the classifier's reason.
 */
export function provenanceFromRouted(data: {
  strategy?: unknown;
  source?: unknown;
  reason?: unknown;
}): ResolvedProvenance | null {
  if (typeof data.strategy !== 'string') return null;
  const source = data.source;
  if (source === 'override') {
    return { strategy: data.strategy, strategySource: 'user-selected' };
  }
  if (source === 'heuristic') {
    return {
      strategy: data.strategy,
      strategySource: 'routed',
      ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    };
  }
  return null;
}

/**
 * Interpret a `strategy_escalated` custom-event payload into provenance.
 * The escalation always re-runs under ReAct, so `strategy` is the `to`
 * target ('react'); the reason summarizes the floor-case evidence that
 * justified the bounded escalation.
 */
export function provenanceFromEscalated(data: {
  from?: unknown;
  to?: unknown;
  failures?: unknown;
}): ResolvedProvenance {
  const to = typeof data.to === 'string' ? data.to : 'react';
  const from = typeof data.from === 'string' ? data.from : 'draft-validate';
  const failCount = Array.isArray(data.failures) ? data.failures.length : 0;
  return {
    strategy: to,
    strategySource: 'escalated',
    reason: `${from}→${to}: ${failCount} floor-case failure(s) after repairs exhausted`,
  };
}

// ─── Routed strategy wrapper (routing + bounded escalation) ──────────

export interface RoutedStrategyConfig {
  /** Factory for the react loop (host wires maxTurns/parallel/reflexion). */
  makeReact: () => AgentStrategy;
  /** Factory for draft-validate (host wires maxRepairs). */
  makeDraftValidate: () => AgentStrategy;
  /** Explicit user override from settings; 'auto'/undefined → heuristic. */
  override?: RoutedStrategyName | 'auto';
  /** Active prompt profile. Firebase tooling stays on ReAct under auto. */
  promptProfile?: AgentPromptProfile;
  /** Active skill routing preference. This is routed provenance, not a user override. */
  strategyPreference?: SkillStrategyPreference;
}

interface EscalationEvidence {
  draftText: string;
  failures: unknown;
}

/**
 * Should an exhausted draft-validate run escalate to ReAct?
 *
 * Calibration finding (c2-routed trial 1, gpt-oss-120b): escalating on ANY
 * exhaustion fired on 4/6 fixtures and burned 73k–176k tokens per run —
 * because the model's own validation cases are frequently wrong while the
 * draft rules are fine. Escalate only on evidence we can trust: a
 * HOST-authored baseline-floor case failing (`source:'floor'`) means the
 * rules are genuinely broken (e.g. an unauthenticated create allowed).
 * Model-authored case failures alone → keep the draft (already written
 * back; the validation report stays visible in the strategy events).
 */
export function shouldEscalateOnExhaustion(failures: unknown): boolean {
  return (
    Array.isArray(failures) &&
    failures.some((f) => (f as { source?: string } | null)?.source === 'floor')
  );
}

/**
 * Wrap routing + escalation as a single `AgentStrategy`:
 *
 *   1. Route the prompt (override wins; heuristic under 'auto') and emit a
 *      `strategy_routed` custom event so hosts can record `routedStrategy`.
 *   2. Delegate to the chosen inner strategy, re-yielding its events.
 *   3. If draft-validate exhausts its repairs (`validation_exhausted`),
 *      re-run the turn under ReAct with the failed draft + validation
 *      failures appended as context (`strategy_escalated` event). Bounded:
 *      once per user prompt by construction.
 */
export function createRoutedStrategy(config: RoutedStrategyConfig): AgentStrategy {
  return {
    id: 'routed',
    async *run(input, signal): AsyncIterable<StrategyEvent> {
      const decision: RouteDecision =
        config.override && config.override !== 'auto'
          ? { strategy: config.override, source: 'override', reason: 'settings strategyMode' }
          : routePrompt(input.prompt, {
              promptProfile: config.promptProfile,
              strategyPreference: config.strategyPreference,
            });

      yield { kind: 'custom', name: 'strategy_routed', data: { ...decision } };

      if (decision.strategy === 'react') {
        yield* config.makeReact().run(input, signal);
        return;
      }

      // ── draft-validate, watching for exhaustion ─────────────────────
      let lastDraft = '';
      let exhausted: EscalationEvidence | null = null;
      let failures: unknown = undefined;
      for await (const ev of config.makeDraftValidate().run(input, signal)) {
        if (ev.kind === 'text') lastDraft += ev.chunk;
        if (ev.kind === 'custom' && ev.name === 'validation_result') {
          failures = (ev.data as { failures?: unknown } | undefined)?.failures;
        }
        if (ev.kind === 'custom' && ev.name === 'validation_exhausted') {
          exhausted = { draftText: lastDraft, failures };
        }
        yield ev;
      }

      // Escalation only applies to HEURISTIC routing — an explicit user
      // override means "use this strategy", not "fall back when it
      // struggles" — and only on trustworthy evidence (a host-authored
      // floor case failed; see shouldEscalateOnExhaustion).
      if (
        !exhausted ||
        signal.aborted ||
        decision.source === 'override' ||
        !shouldEscalateOnExhaustion(exhausted.failures)
      ) {
        return;
      }

      // ── Bounded escalation: one ReAct re-run with the evidence ──────
      yield {
        kind: 'custom',
        name: 'strategy_escalated',
        data: {
          from: 'draft-validate',
          to: 'react',
          failures: exhausted.failures ?? [],
        },
      };

      const rules = parseRules(exhausted.draftText);
      const evidence = [
        'A draft-validate pass already attempted this task and ran out of repairs.',
        'Best draft so far' + (rules ? ' (rules below)' : '') + ':',
        ...(rules ? ['```firestore', rules, '```'] : []),
        `Validation failures (expected vs got): ${JSON.stringify(exhausted.failures ?? [])}`,
        'Use the tools to diagnose and fix these specific failures, then save the corrected files.',
      ].join('\n');

      const escalatedInput: StrategyRunInput = {
        ...input,
        history: [
          ...input.history,
          {
            id: `escalation-${Date.now().toString(36)}`,
            role: 'assistant',
            text: evidence,
            timestamp: Date.now(),
          },
        ],
      };
      yield* config.makeReact().run(escalatedInput, signal);
    },
  };
}
