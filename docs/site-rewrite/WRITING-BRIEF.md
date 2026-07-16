# WRITING BRIEF

The style contract for every page in the docs rewrite. Read this before writing a word. Deviations are earned with intention, not slipped into.

## Who we are on the page

The person who just bought a camera does not read the manual. They go to YouTube and find someone who clearly knows the camera and clearly likes them, and they watch that person take a photo. Then they go take the photo.

We are the person in the video. We show the result first. We narrate the moves. We never hand the reader a manual and walk away. Every page opens with the end result in the reader's words, shows it working, and only then explains the means.

## The one product

Pyric is one system, referred to in the singular, taught as one. Never "the packages," never "the suite," never "the CLI package provides." Pyric does things. Package names appear in exactly two places: install commands, and the API reference section. Everywhere else the subject is Pyric or the reader.

## Verbs, not nouns

We teach behaviors and outcomes, not taxonomy. "Prove a user can touch only their own data" is a page. "The rules simulator" is not. When a noun must appear (a tool name an agent calls, a CLI command), it arrives as the means to the verb, after the verb.

## Say it without saying it

We never claim to be better than the official docs, smarter than the reader, or novel. We prove it by being concrete: the limit with its exact number, the linter message, the verdict with the rule that decided it. This library focuses on the hard parts. The reader concludes the rest themselves. Facts over selling, always. No flourishes, no hype adjectives, no exclamation points.

## Grammar

- Never em dashes. Not once. Use a comma, a period, or parentheses.
- Rarely semicolons.
- Correct but not fussy grammar. Easy to read beats technically precise.
- Contractions are fine. This is a person talking.

## Rhythm (Gary Provost, always)

Vary sentence length deliberately. Short sentences land points. Medium sentences carry the work. And occasionally, when the reader has been given a rest and the moment is right, a long sentence builds and rolls and delivers something that matters. Read every paragraph aloud in your head. If it drones, break it.

## Titles and nav labels (owner review, first pass)

- Concrete over clever, always. A title must say what the page is about on sight. "How the swap works" not "What just happened". "Rules limits" not "The limits that actually bite". "Case studies" not "What's possible".
- Never let a nav item echo its group label ("Get started > Start building" reads as a stutter; "Quickstart" does not).
- Playful phrasing is not worth a vague label. If a reader (or an agent scanning the nav) cannot predict the content from the label, rename it.

## Never against Firebase (owner review, first pass)

Pyric is Firebase tooling, never a competitor and never a critic. Two rules follow. Never frame moving to Pyric as migration ("use in existing code", not "migrate from Firestore"; "coverage of", not "vs"). And never say or imply Firebase's docs are lacking. The measured rules limits are "researched and observed behavior discovered by Pyric's tooling", not "what Google doesn't document". The same for community assumptions: show the verified behavior, skip the myth-busting posture.

## Density (owner review, first pass)

Walls of text are a defect. On a guide page, every H2 section should reach an example (code, a table, or a tight list) within about two short paragraphs. Paragraphs run one to three sentences. If a section needs more prose than that, it is probably two sections, or it belongs in the reference. The API reference is where density is allowed.

## Structure conventions

- H1 is the outcome in the reader's words, not a feature name.
- The first paragraph states the result the reader gets. No preamble, no "In this guide."
- Show a working example early. Code before concepts wherever possible.
- Code blocks are real and runnable against the current surface (check `pyric can-i-use` and the generated conformance pages). Never pseudo-code presented as real.
- Headings continue the narrative ("Watch the denial explain itself"), never label taxonomy ("Denial inspection"). Banned outright (owner review): vague relational labels that describe the section's role instead of its content. "What you do with it", "Where your agent fits", "Why it holds up", "The catalog", "The rest of the wing". If the heading would fit on any product's page, it says nothing about this one.
- Keep pages short. One tangible win per page. Link deeper instead of piling on.
- End with where to go next, one or two links, chosen, not a link farm.

## The agent thread

Every page that has an agent angle carries a short "And from an agent" section near the end: two to four sentences naming the specific tool or skill and what it does better. It points to the Work with an agent section. It is the payoff, not a courtesy. If a page has no genuine agent angle, omit the section rather than force it.

## Honesty rails

- Auth, Firestore, and Rules are v1 and conformance-held. Say things plainly about them.
- Realtime Database and Storage are experimental. Every page about them says so near the top, with a link to the What's experimental page. Never let a reader trust them by accident.
- Never state a benchmark or speed claim we cannot defend. "Chess in pure rules exists" is the claim. Never "10 minutes."
- If a capability has a boundary (an unimplemented method, a cap, a gotcha), name it in place. Boundaries stated plainly build more trust than completeness implied falsely.
- Numbers (conformance counts, tool counts) drift. Prefer "tested against recorded production behavior" over hard-coding counts, except where the number is the point (the rules limits).

## Words we use and avoid

Use: sandbox, backend, rules, verdict, denial, seed, snapshot, replay, ship, prove.
Avoid: leverage, powerful, seamless, simply, easy, just (as minimizer), robust, blazing, magic, revolutionary. Avoid "emulator" except when explicitly contrasting, and never propose emulator workflows.

## Sources of truth

- `pyric can-i-use` and generated conformance pages for what exists and its trust evidence.
- `NOVELTY.md` for the deep material (limits, stdlib, patterns, control plane, replay) and how to frame it.
- `HIERARCHY.md` v3 for what page you are writing and what it promises.
- Existing package docs (`packages/*/docs`) for reusable prose and verified examples. Reuse facts and examples freely, but rewrite the voice to this brief.
- The skills (`.agents/skills/*` here and in firebase-agent-sdk) for domain knowledge.

## The exemplar

`content/overview.md` is the voice anchor. When unsure how a page should sound, read it again.
