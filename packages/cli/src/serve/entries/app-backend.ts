/** Realm-local sandbox; served services may instead use the worker transport. */
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { SERVE_HISTORY_LIMITS } from '../observation-limits.js';

export const sandbox = createSandboxRoot(SERVE_HISTORY_LIMITS);
