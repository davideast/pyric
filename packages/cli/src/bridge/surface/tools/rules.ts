/** The Security Rules service tool. */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 50,
  intro:
    'Security Rules for the sandbox, across the three services that have them. Every lint and simulate names its service, and a path is the path the request targets.',
} satisfies ToolRecord;
