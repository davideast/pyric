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
 * SKILL-AWARE (P4): Firebase Expert is always on. Detected context
 * lenses choose the primary prompt shape; active specialist skills
 * add small overlays when relevant instead of replacing the Firebase
 * frame.
 */
import { isSpecialistSkill, resolveAgentContext } from '~/lib/agent/context';
import { firestoreGameRulesSkill } from '~/lib/skills/firestore-game-rules';
import type { SkillDefinition } from '~/lib/skills/registry';

const HEADER = [
  'You rewrite a developer\'s rough idea into a single, well-shaped prompt for the Pyric Playground agent.',
  '',
  'FIREBASE EXPERT IS ALWAYS ON — Every enhancement starts from Firebase expertise: security rules, data models, Auth users, seed data, traffic, denials, tests, and app UI only when the user asks for an app.',
  '',
  'Your job is the prompt, NOT the implementation. Output ONLY the enhanced prompt as plain text — no preface, no code, no headings, no quoting, no explanation.',
  '',
  'DOMAIN PURITY — the prompt must read like a product/security request, not like instructions for the playground UI:',
  '  - Describe the domain in its own terms only.',
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

const FIREBASE_SHAPE = [
  'A well-shaped Firebase prompt states:',
  '  1. The Firebase surface involved: Firestore, RTDB, Auth, Storage, rules, indexes, seed data, or traffic.',
  '  2. The security or data boundary to reason about: actors, ownership, roles, membership, allowed operations, denied operations.',
  '  3. The evidence the agent should use or produce: rules, seed docs, Auth users, simulations, tests, traffic, denials, or an audit report.',
  '  4. The teaching outcome: explain the modeling or rules principle before applying changes.',
  '  5. No app UI unless the user explicitly asks to build or modify an app.',
].join('\n');

const FIRESTORE_DATA_MODEL_SHAPE = [
  'Shape this as a Firestore data modeling request:',
  '  - Start from the security rules boundary first.',
  '  - Name actors, operations, paths, allowed cases, denied cases, and rule facts.',
  '  - Derive collections, document IDs, fields, membership/role docs, and query shapes from enforceability.',
  '  - Ask the agent to teach each decision before changing rules, seed data, or tests.',
  '  - Require evidence with representative seed docs/Auth users plus one allowed and one denied proof.',
].join('\n');

const RULES_AUDIT_SHAPE = [
  'Shape this as a rules audit request:',
  '  - Name the service and rule file if known.',
  '  - Ask for public access, ownership/role bypasses, missing validation, semantic errors, unsafe wildcards, and query-rule mismatches.',
  '  - Require evidence from lint, simulations/tests, traffic, or denials where available.',
].join('\n');

const QUERY_INDEX_SHAPE = [
  'Shape this as a Firestore query/index design request:',
  '  - Name the read paths, filters, sort order, pagination/cursor needs, and collection-group needs.',
  '  - Ask for index extraction and data-shape tradeoffs.',
  '  - Require the agent to connect query shape back to rules enforceability.',
].join('\n');

const AUTH_SHAPE = [
  'Shape this as a Firebase Auth modeling request:',
  '  - Name providers, user lifecycle, custom claims, Auth users, and how identity maps into Firestore/RTDB rules.',
  '  - Require seed Auth users when identity-specific rules need proof.',
  '  - Avoid fake in-app identity switchers; describe the Auth identities and rule implications directly.',
].join('\n');

const RTDB_RULES_SHAPE = [
  'Shape this as an RTDB rules request:',
  '  - Name the paths, actors, read rules, write rules, validate rules, and cascading access assumptions.',
  '  - Require proof for allowed and denied reads/writes, including child-path behavior where relevant.',
  '  - Ask the agent to explain the rules principle before applying or auditing rules.',
].join('\n');

const RTDB_DATA_MODEL_SHAPE = [
  'Shape this as an RTDB data modeling request:',
  '  - Name the read and write paths, fan-out needs, denormalized copies, indexes, and update boundaries.',
  '  - Connect the path shape to rules enforceability and query limits.',
  '  - Require representative seed data plus allowed and denied proof for the modeled operations.',
].join('\n');

const TAIL = [
  'Length: 30–70 words. Long enough to specify the requirements, short enough that the agent fills in design details on its own.',
  '',
  'Canonical example (study its shape, do NOT echo it):',
  '  Create an app where a user can order from a menu but modify the price. The items are stored in the database and can only be modified by the admin. If the price doesn\'t match the order is rejected.',
  '',
  'If the user\'s rough idea is missing one of the shape properties, infer the most likely fit and write the prompt as if they had specified it. Do not ask clarifying questions. Do not list the properties in your output. Do not invent unusual fields or exotic mechanics — pick the most natural, familiar shape for the domain and Firebase surface.',
  '',
  'Do not name internal tools or UI surfaces in the enhanced prompt. Describe evidence generically as rules, seed data, Auth users, simulations, tests, traffic, or denials.',
  '',
  'Output: the enhanced prompt as one short paragraph, plain prose, no markdown.',
].join('\n');

/**
 * Compose the enhancer prompt for the session's active skills and
 * current rough text. Firebase-native shaping is the default; app
 * shaping appears only when the text clearly asks for app UI or
 * preview work. Specialist skills add overlays rather than replacing
 * the primary shape.
 */
export function buildEnhancerPrompt(
  activeSkills: readonly SkillDefinition[],
  rawInput = '',
): string {
  const context = resolveAgentContext({
    prompt: rawInput,
    activeSkillIds: activeSkills.map((skill) => skill.id),
  });
  const lensIds = new Set(context.lenses.map((lens) => lens.id));
  const shape =
    context.promptProfile === 'app-builder'
      ? [
          `If the idea is a GAME (a board, turns, players, moves, score, win/lose), shape it as a game prompt instead of the app shape below. The prompt must specify:`,
          firestoreGameRulesSkill.enhancerShape,
          '',
          'Otherwise, ' + APP_SHAPE.charAt(0).toLowerCase() + APP_SHAPE.slice(1),
        ].join('\n')
      : lensIds.has('data-modeling') && lensIds.has('firestore')
        ? FIRESTORE_DATA_MODEL_SHAPE
        : lensIds.has('queries-indexes')
          ? QUERY_INDEX_SHAPE
          : lensIds.has('auth')
            ? AUTH_SHAPE
            : lensIds.has('data-modeling') && lensIds.has('rtdb')
              ? RTDB_DATA_MODEL_SHAPE
              : lensIds.has('rules') && lensIds.has('rtdb')
                ? RTDB_RULES_SHAPE
                : lensIds.has('rules') || lensIds.has('audit')
                  ? RULES_AUDIT_SHAPE
                  : FIREBASE_SHAPE;
  const overlays = activeSkills
    .filter((skill) => isSpecialistSkill(skill) && skill.enhancerShape)
    .map((skill) =>
      [
        `Active specialist skill: "${skill.label}". Firebase Expert stays on; do not replace the primary shape. When this specialist is relevant, add these requirements:`,
        skill.enhancerShape,
      ].join('\n'),
    );
  return [HEADER, '', shape, ...overlays.flatMap((overlay) => ['', overlay]), '', TAIL].join(
    '\n',
  );
}

/** The default (no active skills) prompt — kept as a constant for the
 *  pinned tests and any caller without session context. */
export const ENHANCER_SYSTEM_PROMPT = buildEnhancerPrompt([]);
