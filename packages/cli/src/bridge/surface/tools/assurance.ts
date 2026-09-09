/** Judging a change before it reaches production, as a service tool. */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 70,
  intro:
    'Judge rules before they ship: replay a capture, decide its cases, and run a campaign.',
} satisfies ToolRecord;
