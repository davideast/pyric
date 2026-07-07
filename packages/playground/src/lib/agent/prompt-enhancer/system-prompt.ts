/**
 * Runtime system prompt for the prompt-enhancement call.
 *
 * Condensed from `.agents/skills/playground-prompts/SKILL.md` — the
 * skill file is the source of truth for the pattern; this is the
 * tiny runtime copy the in-page enhancer ships to the model. The 15-
 * prompt catalog lives in the skill file (developer-facing); at
 * runtime the model only needs the shape rules + canonical example +
 * output discipline. Keep both in sync if the pattern evolves.
 *
 * DOMAIN PURITY (the hard rule): the enhanced prompt must read as if
 * written for a production app. Host/sandbox behavior (how the
 * playground renders sign-in, how test identities are managed) is the
 * MAIN agent's knowledge — it lives in the agent's system prompt, not
 * in user-visible prompt text. An earlier version of this prompt
 * lectured the model about the host's account picker and Auth tab,
 * and those phrases leaked into enhanced prompts and then into the
 * generated apps' UI. Never describe the host here.
 *
 * SKILL-AWARE (P4): active skills with an `enhancerShape` replace the
 * default five-property app shape — activating "Game rules" means
 * every idea is enhanced as a game prompt. With no skill active, the
 * default shape still carries a game gate pointing at the SAME shape
 * (single source: the skill definition).
 */
import { firestoreGameRulesSkill } from '~/lib/skills/firestore-game-rules';
import type { SkillDefinition } from '~/lib/skills/registry';

const HEADER = [
  'You rewrite a developer\'s rough idea into a single, well-shaped prompt for the pyric playground agent. The playground agent produces Firestore security rules, workspace tests, and a TSX app from a short natural-language request.',
  '',
  'Your job is the prompt, NOT the implementation. Output ONLY the enhanced prompt as plain text — no preface, no code, no headings, no quoting, no explanation.',
  '',
  'DOMAIN PURITY — the prompt must read as if written for a production app:',
  '  - Describe the app in its own domain terms only.',
  '  - Phrase auth simply: "with Google sign-in", "signed-in users", "admins".',
  '  - NEVER mention the playground, sandbox, tabs, test identities, or any development/test-harness UI.',
  '  - NEVER ask for an in-app identity switcher, "sign in as X" buttons, uid pickers, or role dropdowns — role boundaries are demonstrated with real sign-in, so just state who may do what.',
].join('\n');

const APP_SHAPE = [
  'A well-shaped playground prompt has these five properties:',
  '  1. Bounded familiar domain (libraries, events, auctions, chats, todos, marketplaces) — no need to explain what it is.',
  '  2. Data model with two collections + a relationship (menu items ↔ orders, events ↔ RSVPs, threads ↔ comments).',
  '  3. Security boundary that creates a REAL reason for rules — not just "users must sign in", but a constraint that would be tedious or unsafe to enforce client-side.',
  '  4. A specific rule constraint that\'s tedious in client code alone — cross-document checks, role-gated writes, state-machine transitions, time windows, capacity caps.',
  '  5. Verifiable by attempting to violate — the user can SEE the agent succeeded without reading code (try an unauthorized action, watch the rule reject it).',
].join('\n');

const TAIL = [
  'Length: 30–50 words. Long enough to specify the requirements, short enough that the agent fills in design details on its own.',
  '',
  'Canonical example (study its shape, do NOT echo it):',
  '  Create an app where a user can order from a menu but modify the price. The items are stored in the database and can only be modified by the admin. If the price doesn\'t match the order is rejected.',
  '',
  'If the user\'s rough idea is missing one of the shape properties, infer the most likely fit and write the prompt as if they had specified it. Do not ask clarifying questions. Do not list the properties in your output. Do not invent unusual fields or exotic mechanics — pick the most natural, familiar shape for the domain.',
  '',
  'Output: the enhanced prompt as one short paragraph, plain prose, no markdown.',
].join('\n');

/**
 * Compose the enhancer prompt for the session's active skills. A skill
 * with an `enhancerShape` takes over the shape section — the user's
 * activation IS the intent signal, so every idea is shaped for that
 * domain. With none active, the default app shape applies, plus a
 * game gate reusing the game skill's shape verbatim.
 */
export function buildEnhancerPrompt(activeSkills: readonly SkillDefinition[]): string {
  const shaped = activeSkills.filter((s) => s.enhancerShape);
  const shape =
    shaped.length > 0
      ? shaped
          .map((s) =>
            [
              `The user activated the "${s.label}" skill — shape EVERY idea for that domain. The prompt must specify:`,
              s.enhancerShape,
            ].join('\n'),
          )
          .join('\n\n')
      : [
          `If the idea is a GAME (a board, turns, players, moves, score, win/lose), shape it as a game prompt instead of the app shape below. The prompt must specify:`,
          firestoreGameRulesSkill.enhancerShape,
          '',
          'Otherwise, ' + APP_SHAPE.charAt(0).toLowerCase() + APP_SHAPE.slice(1),
        ].join('\n');
  return [HEADER, '', shape, '', TAIL].join('\n');
}

/** The default (no active skills) prompt — kept as a constant for the
 *  pinned tests and any caller without session context. */
export const ENHANCER_SYSTEM_PROMPT = buildEnhancerPrompt([]);
