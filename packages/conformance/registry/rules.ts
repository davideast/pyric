import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The shared NATIVE rules surface registry. Hosts the rules-ENGINE fidelity
 * rows for ALL THREE rules engines — the Firestore rules simulator
 * (firestore-rules), the Storage rules engine (storage-rules), and the RTDB
 * rules simulator (rtdb-rules) — per the rules-native-surface design's dividing
 * line: a row comparing a pyric rules engine to production lives here; a row
 * describing how an SDK surface enforces a rules verdict stays with that SDK.
 *
 * Three contracts (surfaces/firestore-rules.json, surfaces/storage-rules.json,
 * surfaces/rtdb-rules.json) resolve their registry: 'rules' key to this object, on
 * the rtdb / rtdb-modular -> rtdb registry precedent. rtdb-rules was admitted
 * last: it is the engine with no server-side rules test API, so it could not be
 * claimed until its deploy-observe-restore oracle chain landed and produced the
 * `rules-rtdb-` captures its rows cite.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'rules'));

export const rulesRegistry = {
  surface: 'rules',
  label: 'Rules',
  compatPath: 'packages/pyric/docs/rules/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: "# `pyric/rules` compatibility matrix\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| ✓ | **Conforming** — the simulator matches the production verdict, locked by a replayed observation |\n| ⚠ | **Diverged (documented)** — a known simulator divergence from production with a written reason |\n| ✗ | **Bug** — should match production but doesn't; a failing replay pins it |\n| — | **Not implemented yet** — not modeled (deliberately or pending) |\n| ? | **Unverified** — a claim we haven't yet observed against the production engine |\n" },
    ...sections.blocks,
  ],
} satisfies CompatibilitySurfaceRegistry;
