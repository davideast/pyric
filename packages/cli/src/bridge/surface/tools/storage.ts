/** The Cloud Storage service tool. */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 30,
  intro:
    'Cloud Storage in the sandbox, called with the modular SDK method names and argument names. A reference is an object path within the bucket, and bytes travel base64 encoded.',
} satisfies ToolRecord;
