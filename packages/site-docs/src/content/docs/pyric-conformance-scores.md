---
title: "Public API coverage"
group: "Conformance"
section: ""
order: 8001
---
<!-- Generated from the conformance model (registry rows + surface contracts). Do not edit by hand; run bun run compat:generate. -->

# Public API coverage

This is the share of Firebase's public API that Pyric supports. [How does Pyric know it works like Firebase?](../how-we-know-it-matches-firebase/) explains the evidence and its limits.

- **Public runtime surface:** mirrored Firebase runtime exports divided by all exports not exactly reviewed as private in the owning surface contract. Unsupported, deprecated, and deferred public APIs remain in the denominator.
- **Public type surface:** mirrored exported type names divided by non-underscore Firebase exported type names. This measures name presence, not structural assignability.

## Services

<div class="compat-scoreboard">
<a class="compat-score-row" href="../pyric-app-compat/">
<span class="compat-score-name">App</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>90% (9/10)</span>
<span><span class="compat-score-axis">Types</span>66.7% (4/6)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-ai-compat/">
<span class="compat-score-name">AI Logic</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>69.1% (38/55)</span>
<span><span class="compat-score-axis">Types</span>66.5% (109/164)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-auth-compat/">
<span class="compat-score-name">Auth</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>82.4% (70/85)</span>
<span><span class="compat-score-axis">Types</span>39.1% (25/64)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-firestore-compat/">
<span class="compat-score-name">Firestore</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>63.5% (66/104)</span>
<span><span class="compat-score-axis">Types</span>38.5% (30/78)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-database-compat/">
<span class="compat-score-name">Realtime Database</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>79.5% (35/44)</span>
<span><span class="compat-score-axis">Types</span>53.3% (8/15)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-storage-compat/">
<span class="compat-score-name">Storage</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>72.2% (13/18)</span>
<span><span class="compat-score-axis">Types</span>52.9% (9/17)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-messaging-compat/">
<span class="compat-score-name">Messaging</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>100% (5/5)</span>
<span><span class="compat-score-axis">Types</span>100% (8/8)</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-cli-functions-rtdb-compat/">
<span class="compat-score-name">Functions · RTDB</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>integration</span>
<span><span class="compat-score-axis">Types</span>integration</span>
</span>
</a>
<a class="compat-score-row" href="../pyric-rules-compat/">
<span class="compat-score-name">Rules</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>native</span>
<span><span class="compat-score-axis">Types</span>native</span>
</span>
</a>
<div class="compat-score-row compat-score-row--overall">
<span class="compat-score-name">Overall</span>
<span class="compat-score-surface">
<span><span class="compat-score-axis">Runtime</span>73.5% (236/321)</span>
<span><span class="compat-score-axis">Types</span>54.8% (193/352)</span>
</span>
</div>
</div>
