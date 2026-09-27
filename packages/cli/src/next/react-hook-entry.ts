/**
 * The React commit hook, as a Next.js client entry.
 *
 * `withPyric` puts this module first in Next's client entries, so it evaluates
 * before React does. React reads the hook global once, while its own module
 * first evaluates; a hook installed later never hears a commit, and Flow has
 * nothing to follow. The served HTML page and the Vite page runtime install the
 * same hook with an inline script for the same reason.
 */
import { ensureReactHook, type HookWindow } from '../serve/runtime/react-hook.js';

try {
  ensureReactHook(globalThis as HookWindow);
} catch {
  // Diagnostics must not prevent application startup.
}
