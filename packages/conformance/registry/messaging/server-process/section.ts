import { defineRowSection } from '../../section-rows.ts';

/** Client SDKs in a `node --import @pyric/cli/register` process on the Node host (#1082). */
export const section = defineRowSection({
  surface: 'messaging',
  order: 110,
  defaults: {
    section: 'Client SDKs in a registered server process',
    status: 'diverged-documented',
    automation: 'unit-backed',
  },
});

export const row = section.row;
