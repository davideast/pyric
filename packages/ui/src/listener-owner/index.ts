/**
 * Component attribution for listeners, on its own entry point.
 *
 * `@pyric/ui/listener-owner` exists so an application can take the hook
 * without importing the component library barrel and without pulling pyric
 * into its bundle. The module graph reachable from here is this file, the
 * hook, and `react`. Every pyric name it uses is a type, erased at build
 * time, and the capture itself is behind a `process.env.NODE_ENV` gate a
 * bundler folds to a constant, so a production build carries neither.
 *
 * The same hook is also exported from `@pyric/ui/primitives`.
 */
export {
  useListenerOwner,
  type ListenerOwner,
  type UseListenerOwnerOptions,
  type UseListenerOwnerResult,
} from '../primitives/hooks/useListenerOwner.js';
