import { defineRowSection } from '../../section-rows.ts';

/**
 * App Check on the AI path (CDD, climbing with the app-check surface). These
 * rows cite the `app-check-` captures (packages/conformance/docs/app-check/
 * capture-plan.md). Born unverified; flipped to conforms when the assertion
 * sets in APP_CHECK_AI_SUITE passed against the served App Check bridge
 * (`register/app-bridge-app-check`), with the app scenario as integration
 * evidence.
 */
export const APP_CHECK_AI_SUITE = 'packages/cli/test/serve/ai-app-check-passthrough.test.ts';
const APP_CHECK_AI_SCENARIO = 'test/apps/ai-production-app-check/scenario.ts';
/** The same calls on the import-map plane: plain `pyric sandbox`, no Vite (#1290). */
const APP_CHECK_AI_IMPORT_MAP_SCENARIO = 'test/apps/ai-production-import-map/scenario.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 140,
  defaults: {
    section: 'App Check on the AI path',
    status: 'conforms',
    automation: 'oracle-backed',
    conformanceTests: [APP_CHECK_AI_SUITE, APP_CHECK_AI_SCENARIO, APP_CHECK_AI_IMPORT_MAP_SCENARIO],
  },
});

export const row = section.row;
