---
name: playground-prompts
description: Generate well-shaped test/demo prompts for the pyric playground agent. Use when the user asks for "more playground prompts", "demo prompts", "test scenarios for the agent", "prompts that exercise X capability", "more prompts like the menu pricing one", or similar requests for short Firestore-rules-focused prompts that hit a specific shape (bounded domain, two-collection data model, rule-enforced security boundary, verifiable by attempting to violate). Catalog of 15 reference prompts plus the structural pattern they share. Invoke via `/playground-prompts` or pick up automatically when the user's ask matches.
---

# Playground prompts — generating prompts that test the pyric agent well

The pyric playground is the in-browser agent demo at
`examples/playground-next`. The agent's job is to take a short
natural-language request and produce: Firestore security rules, a JS
seeding/probe script, and a TSX app. Whether the agent did its job
correctly is verifiable in the playground without reading code — the
user runs the app, tries an unauthorized operation, and watches
whether the rule rejects it.

That verification path only works if the prompts themselves are
shaped right. This skill is the pattern + a catalog of 15 reference
prompts that hit the pattern.

## The canonical prompt (anchor)

> Create an app where a user can order from a menu but modify the
> price. The items are stored in the database and can only be
> modified by the admin. If the price doesn't match the order is
> rejected.

38 words. Specifies the domain (food ordering), the actors (user,
admin), the data model (menu items with prices, orders), and the
security boundary (users can't modify prices; rules reject
mismatches). The agent figures out the collections, fields, rules,
and UI on its own — but the requirements are unambiguous.

The security constraint is load-bearing. "Users can modify the
price" creates the attack surface; "rules reject mismatches" forces
a rule that checks the order's claimed price against the stored
menu item's price — which needs `get()` inside the rule. Genuinely
educational, exercises real Firestore Rules capability, and has a
natural verification: try to order at the wrong price, watch the
rule reject.

## The structural pattern

Every good playground prompt has these five properties:

1. **Bounded familiar domain.** Libraries, events, auctions, chat
   rooms, todo lists. No need to explain what the domain is.
2. **Data model with two collections + a relationship.** Menu items
   ↔ orders. Events ↔ RSVPs. Threads ↔ comments. Not "build me an
   X" with no schema.
3. **Security boundary that creates a real reason for rules.** Not
   just authentication — actual constraints that would be tedious or
   unsafe to enforce client-side only.
4. **Specific rule constraint that's tedious to enforce in client
   code alone.** Cross-document checks, role-gated writes, state-
   machine transitions, time windows, capacity caps.
5. **Verifiable by attempting to violate.** The user can SEE the
   agent succeeded without reading code.

## Length

30–50 words. Long enough to specify the requirements; short enough
that the agent has to fill in design details. Longer prompts (200+
words specifying every field, every collection, every rule)
constrain the agent to one solution. Shorter prompts ("make me a
chat app", 10 words) leave too much ambiguity and produce wildly
varying outputs.

This length range also matches how real users phrase requests in
agent-driven workflows, so the prompts double as realistic UX
samples.

## Catalog — 15 rules-focused prompts (vary in difficulty)

Each follows the canonical pattern. The five rule capabilities
they exercise are tagged at the end of each — pick by what you
want to test.

### 1. Library borrowing system

Create an app where users can borrow books from a library. Books
have a status field (available, checked out, on hold). Users can
check out an available book, but only one book at a time. Admins
can add new books and change any status. Rules should reject
attempts to check out a book that's already checked out, and
reject users trying to check out a second book while still
holding one.

*Exercises: `get()` cross-document checks, role gating.*

### 2. Event RSVP with capacity limits

Create an app where users can RSVP to events. Each event has a max
capacity set by the admin. Users can RSVP if there's room, but the
rule should reject the RSVP if the event is full. Users can cancel
their own RSVP but not others'. The capacity check should happen
in the rule, not just the UI.

*Exercises: `get()` for capacity, self-vs-other checks.*

### 3. Shared todo list with role-based permissions

Create an app where users belong to teams and todo lists belong to
teams. Team owners can add or remove members. Team members can
create, complete, and uncomplete todos. Non-members can't see the
team's todos at all. Rules should enforce membership for read
access and role for write access. A user trying to read another
team's list should be denied.

*Exercises: list/array membership checks, read denials.*

### 4. Auction with bid validation

Create an app where users can bid on items. Each bid must be
higher than the current highest bid. The current highest bid is
stored on the item document. Rules should reject bids that aren't
higher than the current high. Users can place bids but can't
modify the item's other fields. Admins can create items and end
auctions.

*Exercises: `get()` for current-high comparison, field-scoped
write permissions.*

### 5. Chat rooms with ownership

Create an app where users can create chat rooms. The creator
becomes the owner. Owners can invite other users by adding their
UID to a members array. Only members can read messages or post.
Only owners can update room metadata or remove members. Users can
leave a room they're a member of, but can't remove others.

*Exercises: array membership, owner-vs-member role split, self-
modification on a shared field.*

### 6. Inventory with stock tracking

Create an app where users can purchase products. Each product has
a stock count. A purchase decrements the stock. Rules should
reject purchases when stock is zero, and reject any attempt by a
user to set the stock directly — stock changes only via valid
purchases. Admins can restock at any time.

*Exercises: `request.resource.data` vs `resource.data`, field-
delta validation, read-then-write transactional pattern.*

### 7. Forum with moderation

Create an app where users can post threads and comments. Users can
edit their own posts but only within 5 minutes of creation. After
that, only moderators can edit or delete. Users can delete their
own posts at any time. Moderators have an `isModerator` field on
their user document. Rules should enforce the time window for
self-edits.

*Exercises: time-based rules (`request.time` vs
`resource.data.createdAt`), `get()` on user doc for role check.*

### 8. Survey with one-response-per-user

Create an app where admins create surveys and users submit
responses. Each user can submit exactly one response per survey.
Rules should reject a second response from the same user. Users
can update their response before the survey closes, but can't
update after. Admins set the close time when creating the survey.

*Exercises: document-id-as-uid pattern, `get()` for parent close-
time, time-based rules.*

### 9. File sharing with explicit permissions

Create an app where users can upload files (use Firestore document
references; no actual file storage). Each file has an owner and a
sharedWith array of user IDs. Only the owner and shared users can
read. Only the owner can modify the sharedWith array or delete.
Users can't add themselves to a sharedWith array — only the owner
can grant access.

*Exercises: array-membership reads, self-modification of array
field denied, owner-only write of permission field.*

### 10. Tournament bracket with match validation

Create an app where admins create tournaments with brackets of
matches. Each match has two players and a winner field. Only the
players in that match can submit a result (set the winner to
themselves or the other player). Once both players agree on the
result, the match is locked. Rules should reject submissions from
non-participants and reject result changes after both
confirmations.

*Exercises: participant validation, consensus / locked-state
transitions, state-machine enforcement.*

### 11. Recurring subscription with payment history

Create an app where users can subscribe to plans. Each
subscription has a planId and a status (active, paused,
cancelled). Users can change their own subscription status to
"paused" or "cancelled" but not back to "active" — only an admin
or a successful payment record can reactivate. Payment records can
only be created by admins (simulating webhook ingestion). Rules
should enforce the status transitions.

*Exercises: state-machine transitions, write-source authorization
(admin vs user vs system).*

### 12. Multi-step approval workflow

Create an app where users can submit expense reports. Each report
goes through states: draft, submitted, approved, paid. Users can
edit reports in draft state and submit them. Managers can approve
submitted reports. Finance admins can mark approved reports as
paid. Rules should enforce the state machine — no jumping states,
no skipping approvers.

*Exercises: state-machine enforcement, multi-role authorization,
diff-based field validation.*

### 13. Comments with threaded replies

Create an app where users can comment on articles, and comments
can have replies. Each comment has an authorId and an optional
parentCommentId. Users can edit and delete their own comments.
Deleting a parent comment with replies should soft-delete (set a
deleted flag) rather than remove, preserving the thread structure.
Rules should enforce ownership and prevent users from modifying
the deleted flag on others' comments.

*Exercises: ownership rules, soft-delete vs hard-delete, field-
scoped write permissions on others' docs.*

### 14. Versioned document editing

Create an app where users can collaborate on documents. Each save
creates a version record with the content and timestamp. Users
can read any version of a document they have access to, but only
the document owner can grant access to other users. The version
history is immutable — rules should reject any attempt to update
or delete a version record once created.

*Exercises: immutable collections, owner-managed access control,
parent-doc lookups for child-doc reads.*

### 15. Marketplace listings with state transitions

Create an app where users can list items for sale. Each listing
has states: active, sold, withdrawn. The seller can withdraw their
own listing. Anyone can mark a listing as sold by creating a
purchase record — but only the seller's marking gets the listing
into sold state. Rules should reject buyers trying to modify the
listing directly; they can only create purchase records.

*Exercises: indirect state updates, role-gated state transitions,
sibling-document side effects.*

## Picking a prompt by what you want to test

| Capability | Best prompts to exercise it |
| --- | --- |
| `get()` for cross-doc checks | #1 library, #2 RSVP, #4 auction, #6 inventory |
| List/array membership | #3 todo, #5 chat, #9 file sharing |
| Time-based rules | #7 forum (5-min window), #8 survey close-time |
| State machine transitions | #10 tournament, #11 subscription, #12 expense, #15 marketplace |
| Self-vs-other field permissions | #5 chat, #9 file sharing, #13 comments |
| `request.resource.data` vs `resource.data` validation | menu/pricing anchor, #4 auction, #6 inventory |

## Beyond rules — variations for other playground capabilities

The rules-focused catalog above is the core. To exercise OTHER
parts of the agent stack, vary the constraint type:

- **Transactions** — anything with read-then-write where consistency
  matters. The stock-tracking prompt (#6) does this implicitly; add
  an explicit "transfer balance between two accounts" prompt to
  force a transactional pattern.
- **Compound queries / composite indexes** — a leaderboard with
  filtered + ordered listings, an "events near me" pattern, a
  faceted product search. Exercises the query builder and triggers
  `firestore_extract_indexes` to surface index requirements.
- **Listeners (`onSnapshot`)** — a live-updating dashboard, a real-
  time game state (chess, checkers), a presence indicator. Verifies
  the snapshot machinery in the sandbox.
- **Multi-role flows** — an admin console gated on a custom claim, a
  moderator approval queue, owner-vs-visitor views. The app uses REAL
  sign-in (`signInWithPopup` opens the playground's account picker;
  identities and claims are managed in the Firebase panel's Auth tab) —
  the user demos role boundaries by signing out and signing back in as
  someone else. NEVER prompt for an in-app identity switcher, a
  "sign in as X" button row, or a uid dropdown: those undermine the
  rules story by faking the auth boundary the rules exist to enforce.

These variations are still 30–50 words and still follow the same
five-property pattern; only the dimension being exercised changes.

## What to do when invoked

When the user asks for playground prompts:

1. **Ask which dimension to exercise** if it's not clear from
   context. Default to rules-focused if they don't specify; that's
   the most-trafficked path in the playground.
2. **Generate prompts in the 30–50 word range** that follow the
   five-property pattern. Don't be vague; don't over-specify.
3. **Tag what each exercises** so the user can pick (`get()`,
   array membership, time-based, state machine, etc.).
4. **Lean on the catalog above** — paraphrase, recombine, or
   propose variants on a theme. Don't reinvent unless the user
   asks for a brand-new domain.
5. **Avoid the failure modes**:
   - Too long (200+ words spec'ing every field). Forces one
     solution.
   - Too short ("make me a chat app"). Doesn't specify what's being
     tested.
   - Vague security constraint ("users have permissions"). Doesn't
     create the verification path.
   - No data-model hint at all. Agent invents wildly and the user
     can't verify intent.

## Project context

- The playground lives at `examples/playground-next/`. Agent
  loop in `src/lib/agent/`, prompt composition in `src/lib/agent/
  system-prompt.ts`, tool registry in `src/lib/tools/`.
- Rules are evaluated against the in-browser simulator
  (`@pyric/sandbox`). No real Firebase project is hit unless the
  user signs in and explicitly calls a real-project diagnostic.
- The anchor prompt's verification path: user runs the agent's
  generated code via `runOnce`, watches denials surface in the
  RECENT DENIALS prompt block + the Denials panel. If a denial
  fires when the user tries to order at the wrong price, the rule
  is doing its job.
