/** The Cloud Firestore service tool. */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 10,
  intro:
    'Cloud Firestore in the sandbox, called with the modular SDK method names and argument names. A reference is a path string: a document path has an even number of segments and a collection path an odd number.',
} satisfies ToolRecord;
