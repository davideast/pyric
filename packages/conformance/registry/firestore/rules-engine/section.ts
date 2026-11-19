import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 250,
  prefix: '## Rules engine (via `setRules` from `pyric/sandbox/firestore`)\n\nRules-engine behavior is technically `pyric-admin`\'s `LocalEnvironment`,\nbut it\'s the most-tested surface for divergence — `request.auth`,\ncross-doc reads via `get()`, data validation. These rows pin the\nshape consumer code depends on.\n\nEvery rules-checked request evaluates the ruleset of the latest `setRules`\ncall. A write, a batched write, a document read, a list read, and `simulate()`\non a compiled ruleset share one parse per ruleset source, and the next\n`setRules` call replaces it for the next request\n(`unit:sandbox/firestore/rules-parse-count.test.ts`,\n`unit:sandbox/firestore/rules-state.test.ts`).\n',
  defaults: {
    featureKeys: ["setRules"],
    section: "Rules engine (via `setRules` from `pyric/sandbox/firestore`)",
    api: "Rules engine (via `setRules` from `pyric/sandbox/firestore`)",
  },
});

export const row = section.row;
