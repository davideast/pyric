/** The sandbox itself, as a service tool. */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 60,
  intro:
    'The sandbox itself: what it holds, clearing it, and loading a snapshot into it. These have no Firebase SDK counterpart, so the method names are the tooling names.',
} satisfies ToolRecord;
