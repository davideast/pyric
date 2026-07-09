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
 *   4. (P4) contributes an `enhancerShape` used as lens guidance or
 *      a specialist overlay in the prompt enhancer.
 *
 * Adding a skill = adding one definition file + a registry entry —
 * never new plumbing. Activation state lives in `store/skills.ts`
 * (per-session, persisted in the session payload).
 */
import type { ToolHandler } from '@inbrowser/agent';
// Definition modules import ONLY types from this file (no runtime
// cycle); the registry lists them explicitly.
import { firestoreGameRulesSkill } from './firestore-game-rules';

export type AgentPromptProfile = 'firebase' | 'app-builder';
export type WorkbenchSurface = 'preview' | 'firebase' | 'file';
export type FirebaseWorkbenchSubtab = 'sandbox' | 'data' | 'auth' | 'traffic' | 'seed';
export type SkillToolProfilePreference = 'authoring' | 'diagnostic';

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
  /** Prompt mode selected while this skill is active. */
  promptProfile?: AgentPromptProfile;
  /** Preferred left workbench surface when this skill becomes active. */
  primarySurface?: WorkbenchSurface;
  /** Preferred Firebase workbench sub-tab when this skill becomes active. */
  defaultFirebaseSubtab?: FirebaseWorkbenchSubtab;
  /** Preferred file to show when this skill becomes active. */
  defaultFilePath?: string;
  /** Tool profile to prefer under this skill. */
  toolProfilePreference?: SkillToolProfilePreference;
  /**
   * (P4) Shape block for the prompt enhancer. General Firebase skills
   * map into automatic context lenses; specialist skills add overlay
   * requirements on top of always-on Firebase Expert guidance.
   */
  enhancerShape?: string;
}

/** All known skills, in chip display order. Definition modules are
 *  imported at top and listed explicitly — adding a skill is one
 *  import plus one array entry.
 *
 *  NICHE SKILLS ONLY. The playground's broad Firebase knowledge
 *  (audit methodology, auth modeling, query/index design, RTDB rules
 *  and data modeling) is embedded in the always-on system prompt —
 *  Firebase Expert is the product identity, not a toggle. The six
 *  general firebase-tooling skills that once restated it here were
 *  retired (their knowledge now lives as external-agent skills under
 *  `.agents/skills/`). A skill earns a chip only when it adds a
 *  specialist posture the base prompt does not carry (e.g. Game
 *  rules). Sessions saved with retired ids still load —
 *  `resolveActiveSkills` drops unknown ids. */
const REGISTERED: readonly SkillDefinition[] = [
  firestoreGameRulesSkill,
];

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

export interface WorkbenchIntent {
  promptProfile: AgentPromptProfile;
  primarySurface: WorkbenchSurface;
  defaultFirebaseSubtab?: FirebaseWorkbenchSubtab;
  defaultFilePath?: string;
  toolProfilePreference?: SkillToolProfilePreference;
}

function latestIntentSkill(skills: readonly SkillDefinition[]): SkillDefinition | undefined {
  for (let i = skills.length - 1; i >= 0; i--) {
    const skill = skills[i]!;
    if (
      skill.promptProfile ||
      skill.primarySurface ||
      skill.defaultFirebaseSubtab ||
      skill.defaultFilePath ||
      skill.toolProfilePreference
    ) {
      return skill;
    }
  }
  return undefined;
}

/** Resolve active skills to the session's prompt profile. Firebase
 *  expertise is the product default; app-building is selected by
 *  context when the user's prompt asks for an app or UI. */
export function resolvePromptProfile(
  activeSkills: readonly SkillDefinition[],
): AgentPromptProfile {
  return activeSkills.some((skill) => skill.promptProfile === 'app-builder')
    ? 'app-builder'
    : 'firebase';
}

/** Resolve active skills to the workbench defaults used by the UI
 *  and tool profile. The most recently activated
 *  intent-bearing skill wins for concrete surface defaults. */
export function resolveWorkbenchIntent(
  activeSkills: readonly SkillDefinition[],
): WorkbenchIntent {
  const promptProfile = resolvePromptProfile(activeSkills);
  const latest = latestIntentSkill(activeSkills);
  const primarySurface =
    latest?.primarySurface ?? (promptProfile === 'firebase' ? 'firebase' : 'preview');
  return {
    promptProfile,
    primarySurface,
    ...(latest?.defaultFirebaseSubtab ? { defaultFirebaseSubtab: latest.defaultFirebaseSubtab } : {}),
    ...(latest?.defaultFilePath ? { defaultFilePath: latest.defaultFilePath } : {}),
    ...(latest?.toolProfilePreference
      ? { toolProfilePreference: latest.toolProfilePreference }
      : promptProfile === 'firebase'
        ? { toolProfilePreference: 'diagnostic' as const }
        : {}),
  };
}
