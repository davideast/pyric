/**
 * The deploy provider registry — the single source of truth for deploy targets.
 *
 * Both the CLI dispatcher (`cli/deploy.ts`) and the agent tool registry
 * composer (`registry/compose.ts`) derive from this list, so a target's
 * identity is declared exactly once. Adding a target = its descriptor module +
 * one line here.
 *
 * Strangler-fig migration: a target listed here dispatches through the
 * {@link DeployProvider} contract; a target NOT listed here falls through to the
 * legacy if-ladder in `cli/deploy.ts` until it is migrated. The ladder is deleted
 * only once this registry covers every target.
 */
import type { DeployProvider } from './provider.js';
import { functionsProvider } from './providers/functions.js';
import { hostingProvider } from './providers/hosting.js';
import { storageProvider } from './providers/storage.js';
import { firestoreRulesProvider, firestoreIndexesProvider } from './providers/firestore.js';

export const DEPLOY_PROVIDERS: readonly DeployProvider[] = [
  firestoreRulesProvider,
  firestoreIndexesProvider,
  hostingProvider,
  functionsProvider,
  storageProvider,
];

export const providerByTarget: ReadonlyMap<string, DeployProvider> = new Map(
  DEPLOY_PROVIDERS.map((p) => [p.target, p] as const),
);
