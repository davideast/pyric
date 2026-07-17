<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# Conformance scores

Public runtime surface, public type surface, and behavior fidelity answer different questions. [How does Pyric know it works like Firebase?](../../../../docs/site-rewrite/content/trust/how-we-know-it-matches-firebase.md) explains the evidence and its limits.

- **Public runtime surface:** mirrored non-underscore Firebase runtime exports divided by all public runtime exports. Unsupported, deprecated, and deferred public APIs remain in the denominator.
- **Public type surface:** mirrored exported type names divided by all Firebase exported type names. This measures name presence, not structural assignability.
- **Behavior fidelity:** conforming registry rows divided by all tracked rows. Documented divergences, bugs, unsupported behavior, and unverified behavior remain in the denominator.

Every fidelity bar shows the full five-state distribution. Public surface values stay outside the bar so breadth cannot be mistaken for behavior.

## Scores

<div class="compat-scoreboard">
<a class="compat-score-row" href="../pyric-app-compat/">
<span class="compat-score-name">App</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>90% (9/10)</span>
<span><span class="compat-score-axis">Types</span>66.7% (4/6)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">85.2%</strong>
<span>23/27 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 23 conform, 2 documented divergences, 0 bugs, 1 unsupported, 1 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 23" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 2" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 1" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">23 conform · 2 documented divergences · 0 bugs · 1 unsupported · 1 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-ai-compat/">
<span class="compat-score-name">AI Logic</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>69.1% (38/55)</span>
<span><span class="compat-score-axis">Types</span>66.5% (109/164)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">92.3%</strong>
<span>72/78 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 72 conform, 6 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 72" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">72 conform · 6 documented divergences · 0 bugs · 0 unsupported · 0 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-auth-compat/">
<span class="compat-score-name">Auth</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>82.4% (70/85)</span>
<span><span class="compat-score-axis">Types</span>39.1% (25/64)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">81.8%</strong>
<span>99/121 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 99 conform, 16 documented divergences, 0 bugs, 5 unsupported, 1 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 99" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 16" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 5" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">99 conform · 16 documented divergences · 0 bugs · 5 unsupported · 1 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-firestore-compat/">
<span class="compat-score-name">Firestore</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>63.5% (66/104)</span>
<span><span class="compat-score-axis">Types</span>38.5% (30/78)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">87.6%</strong>
<span>141/161 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 141 conform, 20 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 141" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 20" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">141 conform · 20 documented divergences · 0 bugs · 0 unsupported · 0 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-database-compat/">
<span class="compat-score-name">Realtime Database</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>79.5% (35/44)</span>
<span><span class="compat-score-axis">Types</span>53.3% (8/15)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">76.6%</strong>
<span>154/201 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 154 conform, 9 documented divergences, 0 bugs, 26 unsupported, 12 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 154" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 9" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 26" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 12" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">154 conform · 9 documented divergences · 0 bugs · 26 unsupported · 12 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-storage-compat/">
<span class="compat-score-name">Storage</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>72.2% (13/18)</span>
<span><span class="compat-score-axis">Types</span>52.9% (9/17)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">86%</strong>
<span>86/100 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 86 conform, 6 documented divergences, 0 bugs, 8 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 86" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 8" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">86 conform · 6 documented divergences · 0 bugs · 8 unsupported · 0 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-messaging-compat/">
<span class="compat-score-name">Messaging</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>100% (5/5)</span>
<span><span class="compat-score-axis">Types</span>100% (8/8)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">100%</strong>
<span>17/17 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 17 conform, 0 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 17" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">17 conform · 0 documented divergences · 0 bugs · 0 unsupported · 0 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-cli-functions-rtdb-compat/">
<span class="compat-score-name">Functions · RTDB</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>integration</span>
<span><span class="compat-score-axis">Types</span>integration</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">92.3%</strong>
<span>12/13 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 12 conform, 0 documented divergences, 0 bugs, 0 unsupported, 1 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 12" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">12 conform · 0 documented divergences · 0 bugs · 0 unsupported · 1 unverified</span>
</a>
<a class="compat-score-row" href="../pyric-rules-compat/">
<span class="compat-score-name">Rules</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>native</span>
<span><span class="compat-score-axis">Types</span>native</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">86.4%</strong>
<span>57/66 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 57 conform, 9 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 57" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 9" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">57 conform · 9 documented divergences · 0 bugs · 0 unsupported · 0 unverified</span>
</a>
<div class="compat-score-row compat-score-row--overall">
<span class="compat-score-name">Overall</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>73.5% (236/321)</span>
<span><span class="compat-score-axis">Types</span>54.8% (193/352)</span>
</span>
<span class="compat-score-fidelity">
<strong class="compat-score-pct">84.3%</strong>
<span>661/784 conform</span>
</span>
<div class="compat-stat-bar compat-stat-bar--mini" role="img" aria-label="Behavior distribution: 661 conform, 68 documented divergences, 0 bugs, 40 unsupported, 15 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 661" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 68" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 40" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 15" aria-hidden="true"></span>
</div>
<span class="compat-score-breakdown">661 conform · 68 documented divergences · 0 bugs · 40 unsupported · 15 unverified</span>
</div>
</div>
