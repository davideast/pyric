<!--
Write this for a reviewer, not for a log. Delete these instructions when you post.

THE ONE TEST THAT CATCHES MOST OF IT: read each sentence and ask "could this appear,
unchanged, in a different PR?" If yes, cut it. Generic openings, category headings, and
filler about the work all fail this test. What survives is specific to THIS change.

THE SHAPE:

1. ONE LINE, THEN THE CODE. Start with a single sentence naming what the PR adds or
   changes and what it is ("Adds `@pyric/cli/assurance`, a library that ..."), then the
   hero example immediately. The line orients; the code teaches. Do not open cold on a
   code block, and do not pad the line into a paragraph. Real imports, real values,
   runnable, from the consumer's seat. If the change is a behavior fix, show what the
   consumer writes and what they get; if it is docs, show what the reader now reads. Name
   the subject concretely: a bare `update(...)` that could belong to any service teaches
   nothing. A reviewer should know what changed before a sentence of prose.

   THE SAMPLE DEFINES EVERYTHING IT USES. No `myCampaign`, no `...`, no "assume a config".
   If the input is the interesting part of the change, the input goes in the sample in
   full. A reader who does not already know the system must be able to run it. A
   placeholder variable is a confession that you hid the thing worth showing.

   AND IT EXPLAINS ITS OWN TERMS. If a result is `local-counterexample` or `engine-gap`,
   the comment says what pyric actually DID to produce it, in plain words. A term the
   reader cannot define from the sample is noise, however precise.

2. SHOW THE WHOLE SURFACE, BY USING IT. If the change has more API than the hero example,
   cover the rest the same way: as code a consumer runs. Every entry point the reader
   would reach for, the programmatic API, the MCP/agent path, the CLI. A bulleted list of
   type names or tool names is not usage; it is an index, and an index teaches nobody how
   to use the thing. Be exhaustive in use, not in enumeration.

3. NARRATIVE HEADINGS STATE A FACT ABOUT THIS CHANGE. "resource.id no longer allows what
   Firebase denies" beats "Bug fix". Not a category ("Behavior changes"), not a
   dramatization ("a member can seize the room"), not an assumption about the reader ("the
   kind a developer writes without thinking"), and, on a PR that introduces something new,
   not delta-framing ("This PR's change:"), because there is nothing before it to delta
   against.

4. SAY IT PRECISELY, NOT BIGGER THAN IT IS. State the mechanism as it works. Do not reach
   for a sentence that, read literally, claims something false or alarmist to make the
   change sound larger ("security rules routinely allow what they deny" indicts the engine
   for a bug that is not there). Use the codebase's own vocabulary, not a casual synonym in
   its place (we deny, we do not "forbid").

5. SHOW, THEN EXPLAIN. Code, output, or table first; the paragraph after it, if one is
   needed at all. Highlight the lines that matter.

6. THE REVIEWER'S QUESTIONS, NEAR THE TOP. What is the risk? What is held for judgment?
   What could this break? Say it plainly, not buried at the bottom.

7. VERIFICATION AND FINDINGS GO IN <details>. Exit codes, test counts, what the author
   discovered, what they declined to do, collapse it. The reviewer opens it if they want
   it. It is not the story.

WHAT THIS IS NOT: a report of what an agent did. Nobody is reviewing the work session.
They are reviewing the change.

COVERAGE PRs: if this moves a published number, state the delta AND its cause ("verified
+4: two new scenarios captured, zero reclassifications"). A number that moved because a
denominator shrank is not an improvement, and the description must not let a reviewer
mistake it for one.
-->

```ts
// The change, as a consumer writes it. Replace this block.
```

## A heading that states what changed

<!-- What a reader needs to know, after they have seen the code. -->

## Risk

<!-- What could break. What needs judgment. Delete if genuinely nothing. -->

<details>
<summary>Implementation notes</summary>

<!-- Findings, decisions declined, verification, exit codes. -->

</details>
