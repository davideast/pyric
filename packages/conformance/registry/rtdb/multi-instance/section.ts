import { defineRowSection } from '../../section-rows.ts';

/** Production gives each database URL its own data and rules. Each row here
 * names one Pyric path that serves database URLs, and the test that pins it. */
export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 70,
  prefix: "### Multiple database instances\n\nIn production each database URL is its own instance, with its own data and its own rules. The in-page sandbox keeps one backend per canonical URL, so `getDatabase(app, url)` isolates data there, and the dev server loads each instance its own rules from `firebase.json`. The served worker host, in the SharedWorker and in the Node host, holds one store and one ruleset per instance.\n",
  defaults: {
    section: "Multiple database instances",
    status: "diverged-documented",
    automation: "unit-backed",
  },
});

export const row = section.row;
