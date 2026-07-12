<!--
Write this for a reviewer, not for a log. Delete these instructions when you post.

THE SHAPE:

1. OPEN WITH THE CODE. A hero example, first thing, no preamble. Real imports, real
   values, runnable, from the consumer's seat. If the change is a behavior fix, show
   what the consumer writes and what they get. If it is an API, show the API being
   used. A reviewer should understand what changed before reading a single sentence
   of prose.

2. NARRATIVE HEADINGS. A heading states a fact, not a category. "Two capabilities now
   abstain" beats "Behavior changes". "resource.id no longer allows what Firebase
   denies" beats "Bug fix".

3. SHOW, THEN EXPLAIN. Code sample, output, or table first; the paragraph after it, if
   one is needed at all. Highlight the lines that matter.

4. THE REVIEWER'S QUESTIONS. What is the risk? What is held for judgment? What could
   this break? Say it plainly, near the top, not buried.

5. VERIFICATION IS ONE LINE, AT THE BOTTOM. Exit codes and test counts are not the
   story. Put them in the details block.

6. FINDINGS AND PROCESS NOTES GO IN <details>. What the author discovered, what they
   declined to do, what they verified — collapse it. The reviewer opens it if they
   want it.

WHAT THIS IS NOT: a report of what an agent did. Nobody is reviewing the work session.
They are reviewing the change.

COVERAGE PRs: if this moves a published number, state the delta AND its cause
("verified +4: two new scenarios captured, zero reclassifications"). A number that
moved because a denominator shrank is not an improvement, and the description must
not let a reviewer mistake it for one.
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
