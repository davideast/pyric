/**
 * Skill registry — skills as DATA, not plumbing.
 *
 * A skill is session-scoped, user-activated knowledge that shapes how
 * the agent works (e.g. "Game rules"). Activating one:
 *   1. injects its small `brief` into the system prompt (a POINTER,
 *      not a manual — the killed C3 push-injection experiment showed
 *      wholesale skill injection moves correctness DOWN at flat cost;
 *      see agent-shell/man-pages.ts docblock),
 *   2. publishes its full `manBody` as a pull-based `man <topic>` page
 *      (visible only while the skill is active),
 *   3. registers its extra `tools` (if any) for the turn,
 *   4. (P4) contributes an `enhancerShape` that reshapes the prompt
 *      enhancer for the skill's domain.
 *
 * Adding a skill = adding one definition file + a registry entry —
 * never new plumbing. Activation state lives in `store/skills.ts`
 * (per-session, persisted in the session payload).
 */
import type { ToolHandler } from '@inbrowser/agent';
// Definition modules import ONLY types from this file (no runtime
// cycle); the registry lists them explicitly.
import { firestoreGameRulesSkill } from './firestore-game-rules';

export interface SkillDefinition {
  /** Stable id — persisted in session payloads; never rename. */
  id: string;
  /** Chip label, e.g. "Game rules". */
  label: string;
  /** Material-symbols icon name for the chip. */
  icon: string;
  /** One-line description (chip tooltip). */
  description: string;
  /**
   * The ALWAYS-ON nudge injected into the system prompt while active.
   * Budgeted: ~10 lines max — a mental-model sentence, what exists
   * (tools/stdlib), the one or two hard constraints, and the pointer
   * to `man <manTopic>`. Knowledge beyond that belongs in `manBody`.
   */
  brief: string;
  /** `man` topic name. Must not collide with MAN_TOPICS in agent-shell. */
  manTopic: string;
  /** One-line apropos summary for `man -k`. */
  manSummary: string;
  /** Full pull-based knowledge body (the condensed SKILL.md). */
  manBody: string;
  /** Extra tool handlers available while the skill is active. */
  tools?: () => ToolHandler[];
  /**
   * (P4) Shape block for the prompt enhancer — replaces the default
   * five-property app shape when this skill is active.
   */
  enhancerShape?: string;
}

/** All known skills, in chip display order. Definition modules are
 *  imported at top and listed explicitly — adding a skill is one
 *  import plus one array entry. */
const REGISTERED: readonly SkillDefinition[] = [firestoreGameRulesSkill];

/** Test seam: unit tests inject fixture skills without touching the
 *  shipped registry. Never call outside tests. */
let testOverride: readonly SkillDefinition[] | null = null;
export function __setSkillsForTest(skills: readonly SkillDefinition[] | null): void {
  testOverride = skills;
}

/** All known skills, in chip display order. */
export function listSkills(): readonly SkillDefinition[] {
  return testOverride ?? REGISTERED;
}

export function skillById(id: string): SkillDefinition | undefined {
  return listSkills().find((s) => s.id === id);
}

/** Resolve active ids → definitions, dropping unknown ids (a session
 *  saved with a since-removed skill must still load). */
export function resolveActiveSkills(ids: readonly string[]): SkillDefinition[] {
  const out: SkillDefinition[] = [];
  for (const id of ids) {
    const s = skillById(id);
    if (s) out.push(s);
  }
  return out;
}
