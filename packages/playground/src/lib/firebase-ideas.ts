/**
 * Curated "what can I build" Firebase feature ideas for the Firebase >
 * Ideas tab (feature #4). Each idea is a common, applicable Firebase
 * pattern the agent can build end-to-end in the playground: it names
 * the feature, explains what gets built (data model + rules + UI), and
 * carries an editable example prompt the user can send straight to the
 * agent.
 *
 * These are intentionally static + curated (not model-generated): a
 * hand-picked set of high-signal starting points is more useful as a
 * discovery surface than an open-ended generator, and it costs no
 * tokens to render. The example prompts are written to exercise the
 * playground's strengths — auth + Firestore + security rules — so the
 * denial inspector, rules simulator, and seed tools all light up.
 */

export interface FirebaseIdea {
  /** Stable id (also the card key). */
  id: string;
  /** Material Symbols glyph name for the card icon. */
  icon: string;
  /** Short card title. */
  title: string;
  /** One-line card subtitle. */
  tagline: string;
  /** What the agent will build, as a few plain bullets (data + rules +
   *  UI). Present on the curated starters; AI-generated ideas omit it
   *  (the drill-in shows the tagline instead). */
  builds?: string[];
  /** Editable example prompt seeded into the drill-in composer. */
  examplePrompt: string;
}

export const FIREBASE_IDEAS: readonly FirebaseIdea[] = [
  {
    id: 'auth-profiles',
    icon: 'account_circle',
    title: 'Sign-in + user profiles',
    tagline: 'Google auth with a per-user profile document',
    builds: [
      'Google sign-in with a real auth UI (sign in / user chip / sign out)',
      'A `users/{uid}` profile doc created on first sign-in',
      "Rules: a user can read any profile but write only their own",
    ],
    examplePrompt:
      'Build a Google sign-in flow that creates a `users/{uid}` profile document (displayName, photoURL, createdAt) on first sign-in. Security rules must let anyone read profiles but only the owner write their own. Show the signed-in user chip and a sign-out button.',
  },
  {
    id: 'todo-per-user',
    icon: 'checklist',
    title: 'Per-user todo list',
    tagline: 'Private todos scoped to the signed-in user',
    builds: [
      'A `todos` collection with an `ownerUid` field',
      'Create / toggle / delete, filtered to the current user',
      'Rules: each user reads + writes only their own todos',
    ],
    examplePrompt:
      'Build a todo list where each todo has { text, done, ownerUid, createdAt } in a `todos` collection. Users only see and edit their own todos. Security rules must enforce that ownerUid equals the authenticated user on create, and block reading or writing another user\'s todos. Seed a few example todos.',
  },
  {
    id: 'realtime-chat',
    icon: 'forum',
    title: 'Realtime chat room',
    tagline: 'Live messages with onSnapshot',
    builds: [
      'A `rooms/{roomId}/messages` subcollection, live via `onSnapshot`',
      'Send a message as the signed-in user; messages ordered by time',
      'Rules: only signed-in users post, and the author must match auth',
    ],
    examplePrompt:
      'Build a realtime chat room using a `rooms/general/messages` subcollection with live onSnapshot updates. Each message is { text, authorUid, authorName, createdAt }. Security rules must require sign-in to read, and on create the authorUid must equal request.auth.uid. Seed a couple of messages.',
  },
  {
    id: 'leaderboard-counters',
    icon: 'leaderboard',
    title: 'Leaderboard + safe counters',
    tagline: 'Increment-by-one enforced in rules',
    builds: [
      'A global `counters` doc and per-user `scores`',
      'A click/score action that increments by exactly one',
      'Rules that reject any increment other than +1 (anti-cheat)',
    ],
    examplePrompt:
      'Build a leaderboard where each signed-in user has a score in `scores/{uid}` and there is a global `counters/global` total. A button increments the score by one. Security rules must enforce that a score update increases by exactly one and that click logs match the authenticated user. Add a cheat button that tries to add 100 so the rule visibly blocks it.',
  },
  {
    id: 'social-feed',
    icon: 'dynamic_feed',
    title: 'Social feed with likes',
    tagline: 'Posts anyone can read, likes you own',
    builds: [
      'A `posts` collection (author, text, likeCount)',
      'A `posts/{id}/likes/{uid}` subcollection for who liked',
      'Rules: public read, authored writes, one like per user',
    ],
    examplePrompt:
      'Build a social feed with a `posts` collection { authorUid, authorName, text, createdAt } and a `posts/{postId}/likes/{uid}` subcollection. Anyone signed in can read posts; only the author can edit or delete their post; a user can like a post only as themselves (the like doc id must equal their uid). Seed a few posts.',
  },
  {
    id: 'role-based-access',
    icon: 'admin_panel_settings',
    title: 'Role-based access',
    tagline: 'Admin vs member via custom claims',
    builds: [
      'A shared `content` collection any member can read',
      'Admin-only writes gated on a custom claim',
      'Rules using `request.auth.token.admin` for the boundary',
    ],
    examplePrompt:
      'Build a page with a shared `content` collection where any signed-in member can read, but only admins can create or edit. Security rules must gate writes on the custom claim `request.auth.token.admin == true`. Seed an admin and a regular test user in the Auth tab so I can demo the boundary by signing in as each.',
  },
] as const;
