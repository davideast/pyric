/**
 * The Cloud Functions trigger runtime tool.
 *
 * Callable functions are a deferred mirror by design: `pyric/functions` links
 * and throws on every call, so there is no `call` method here. This tool
 * covers only what the RTDB trigger runtime actually has: discovering
 * handlers, running one on a synthetic event without writing, and reading
 * back the runs that fired.
 */
import type { ToolRecord } from '../method-types.js';

export default {
  order: 47,
  intro:
    'Cloud Functions triggers in the sandbox: discover the RTDB handlers a project defines, run one on a synthetic event without writing to the database, and read back the runs that fired. Callable functions are not mirrored yet.',
} satisfies ToolRecord;
