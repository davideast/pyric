# MESSAGING (top of funnel)

The words, decided before the form. Form comes after and serves this; nothing here prescribes layout. Every line below must pass two tests: the brief's voice rules, and the cliche test, which is the heading rule generalized to copy: if the line would fit on any product's page, it says nothing about this one.

## The moment

A developer lands on pyric.dev. They know Firebase, or their coding agent does. They gave us thirty seconds, not five minutes. They are asking, silently and in order: what is this, how hard is it, do I already know it, why would I care, is it real, what do I do now. The messaging answers those six questions in that order and stops.

A second audience reads the same words: the agent a developer points at the site. Every claim should be as parseable as it is scannable.

## The one thing

If they remember one sentence:

> **Firebase that runs in your browser.**

This is the identity line and it is already earned (the README, the Studio hero). It names a mechanism, not an audience. It is a paradox that demands resolution, which buys the second sentence.

The fixed tagline that follows it (David's call, 2026-07-10):

> Agent development without production consequences.

The pair divides the work cleanly: the identity line names the mechanism, the tagline names the payoff and the era. Note the README currently reads "Agentic coding without production consequences"; one wording should win everywhere.

Support test for every other line on the page: does it resolve, prove, or open a door from this sentence? If not, cut.

## The beats, in order, with the copy

### 1. What is this? (the resolution)

Primary:

> Your `firebase/*` code, unchanged, against a backend that lives in the tab. In production it talks to real Firebase. **Production never knows.**

Alternates for the closing line, if "Production never knows" reads too cute:

- "Production is never in the loop."
- "Nothing reaches production until you ship."

The sentence must carry three facts in one breath: code unchanged, backend local, production untouched. The rest of the page assumes these three are landed.

### 2. How hard is it? (the cost of entry)

The proof is two commands, shown as commands:

```
npm i -g pyric-tools
npx pyric dev
```

Caption:

> No account. No project. No emulator. A working backend before your coffee is warm.

The three "No" fragments are the tax the reader already resents, named. The coffee line is the only warmth on the page; if it reads as too much, the fallback is: "A working backend in the first minute of a project."

### 3. Do I already know it? (recognition)

> **You already know the API.**

```
npm i pyric       === npm i firebase
npm i pyric-admin === npm i firebase-admin
npm i pyric-tools === npm i firebase-tools
```

Caption:

> The same imports, the same calls, mirrored one to one. Nothing new to learn before the first write lands.

Recognition-plus-delta: the triptych does the work, the caption only confirms it. This beat exists because "new tool" is a cost, and this one costs almost nothing to adopt.

### 4. Why would I care? (three payoffs, each with a receipt)

Three, not five. Verbs, not features. Each claim is one sentence and its proof is one line of real output, because showing a verdict beats describing one.

**Prove your rules before you deploy.**
> Every operation returns a verdict, and a denial names the rule that said no.
> `deny notes/n1 · Rule #1 (write)`

**Watch every read and write, live.**
> The backend is an event stream. No log lines, no guessing.
> `allow set notes/n1 · alice · 1.4ms`

**Hand the whole backend to your agent.**
> One flag exposes it over MCP. Nothing it does leaves your machine.
> `npx pyric dev --bridge`

Order question, open: rules first (the strongest thing we do) or agent first (the timeliest reason someone arrived). Current call is rules first because it is provable on sight; the agent line lands harder after trust exists. Reverse if traffic says arrivals are agent-led.

### 5. Is it real? (the receipt)

> "Behaves like Firebase" is tested, not asserted: probes run against production, and their recorded behavior replays in CI on every change.

Then the five services in the compat dot language: Firestore, Auth, Rules solid; Realtime Database, Storage hollow, with:

> Green is conformance-held. Hollow is experimental, honestly.

No counts. Counts drift and invite comparison-shopping; the dot plus the linked matrix is the receipt. "Experimental, honestly" is load-bearing: the honesty IS the differentiator, so it gets said where the weakness shows.

### 6. What do I do now? (the doors)

Two doors, named by outcome, not by document type:

- **Start building** (the quickstart)
- **Set up your agent**

And one quiet third for the reader who wants prose: "Prefer the five-minute read?" pointing at the Overview. Never more than these three. A door per audience: human building, human delegating, human reading.

## The copy, ranked by importance

Written after the importance ranking (identity, safety, feasibility, rules, observe/hand-over, conformance, setup). Where this differs from the beat copy above, this is the newer draft.

### 1. Identity

> **Firebase that runs in your browser.**
>
> Agent development without production consequences.
>
> Your `firebase/*` code, unchanged, against a backend that lives in the tab. In production it talks to real Firebase.

The tagline is fixed. The third line stays because the tagline promises and the line explains; cut it only if the pairing needs to stand alone.

### 2. Nothing can touch production

> **Every write lands in the tab.**
>
> Every delete, every rules change, every experiment that goes sideways stays on your machine. Your agent can work all night. Production sleeps through it.

The headline was "Production is never in the loop" before the tagline existed; the tagline now makes that claim at the top, so this section leads with the mechanism that proves it instead of repeating it. "Production sleeps through it" is the riskiest line here; fallback close: "Production never hears about it."

### 3. Your code, unchanged

> **You already wrote this code.**
>
> ```
> npm i pyric       === npm i firebase
> npm i pyric-admin === npm i firebase-admin
> npm i pyric-tools === npm i firebase-tools
> ```
>
> Same imports, same calls, same behavior, mirrored one to one. If you know `getDoc`, `onSnapshot`, and `signInWithEmailAndPassword`, you already know this library.

### 4. Rules become provable

> **Every operation returns a verdict.**
>
> Write a rule, make a request, get an answer. A denial names the rule that said no.
>
> `deny notes/n1 · Rule #1 (write)`
>
> You stop deploying rules to find out what they mean.

### 5. Watch it, then hand it over

> **Watch it work. Then hand it over.**
>
> Every read, write, and auth event streams live in Studio while your app runs. When it's the agent's turn, one flag exposes the same backend over MCP: real queries, real rules, real verdicts.
>
> `npx pyric dev --bridge`
>
> Nothing it does leaves your machine.

### 6. Tested, not asserted

> **"Behaves like Firebase" is a test result.**
>
> Probes run against production Firebase and record what it actually does. Those recordings replay in CI on every change, so drift fails the build before it reaches you. Firestore, Auth, and Rules hold that bar today. Realtime Database and Storage don't yet, and the docs say so.

### 7. The cost of entry

> **Two commands. No account.**
>
> ```
> npm i -g pyric-tools
> npx pyric dev
> ```
>
> No project to create. No console to visit. No emulator to configure. A working backend in the first minute of a project.

## What we refuse to say

- Any superlative (fastest, easiest, powerful, seamless). The mechanism is the pitch.
- "Emulator, but better." We contrast only in the factual "No emulator" fragment and stop.
- Anything against Firebase. Pyric is Firebase tooling; the triptych says it structurally.
- Benchmark or speed claims. "Before your coffee is warm" is texture, not a metric.
- The novelty backstory (chess, the limits, the stdlib). Top of funnel earns the click; the depth is one level down where it can breathe. The hard parts reveal themselves.
- More than one exclamation of any kind. There are currently zero. Keep zero.

## Placement recommendation

The messaging above is a front door, and it is currently standing in the hallway. The Docs tab is the last tab in the nav; a stranger's first screen should not live behind it.

Recommendation: this becomes **Home on the static prod site only**. pyric.dev's `/` today shows Studio's Home surface, an activity feed that is empty and meaningless to a stranger. The two audiences split cleanly:

- **pyric.dev `/` (stranger)**: this messaging. Their next click is the quickstart, the agent setup, or the docs.
- **`pyric dev --ui` Home (working developer)**: the live activity hub, unchanged. They already bought; showing them a pitch would be noise.

The static build already has a flag (`STUDIO_STATIC`) that distinguishes the two, so the split is buildable without forking Studio. `/docs/` then goes back to being the library's front (the nav landing or the Overview), not a pitch.

## What this asks of the form (constraints only)

- Beat 1 must land without scrolling, on a phone.
- The receipts must read as real output, not as decorated quotes.
- The reader should be able to leave at any beat with something true.
- Nothing on the page should require hover to understand.
- However it is shaped, it should not smell like a funnel: no ladder of centered sections marching to a CTA. The current draft does exactly that and it is the thing to lose when form gets designed.

The form conversation starts after this page of words is agreed.
