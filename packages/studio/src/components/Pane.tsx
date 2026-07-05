/**
 * Pane renderer (T4).
 *
 * Each tab routes to a pane. Tabs backed by a `@pyric/ui` area mount that
 * surface (see `panes.tsx`); those components are pure-props and render an
 * empty state with no live handle, so they're on screen today and fill with
 * data once T3's local backend resolves the env. Tabs with no `@pyric/ui`
 * surface (Action Center, Rules, App Builder) carry a Wave-2/3 feature and show
 * a feature-preview empty state. The Agent tab uses `@pyric/ui/agents`'
 * `EmptyState` directly (via `PaneEmptyState`).
 *
 * Nothing here crashes when the env factory throws (T3 not landed): the surfaces
 * render their empty state regardless of env status, and the empty-state copy is
 * backend-aware.
 */

import { PaneEmptyState } from './PaneEmptyState.js';
import {
  AuthPane,
  FirestorePane,
  StoragePane,
  TrafficPane,
} from './panes.js';
import { ActionCenter } from '../features/action-center/index.js';
import { RulesDebugPane } from '../features/rules-debug/index.js';
import { findTab } from '../shell/tabs.js';

export function Pane({ tabId }: { tabId: string }) {
  const tab = findTab(tabId);

  // Bespoke Wave-2 features routed by id before the area switch (no `@pyric/ui`
  // area backs them).
  // Action Center (F1): aggregation over the event stream.
  if (tab.id === 'action') {
    return <ActionCenter />;
  }
  // Rules tab (F4): rules-failure debugging.
  if (tab.id === 'rules') return <RulesDebugPane />;

  switch (tab.area) {
    case 'firestore':
      return <FirestorePane />;
    case 'auth':
      return <AuthPane />;
    case 'storage':
      return <StoragePane />;
    case 'traffic':
      return <TrafficPane />;
    case 'agents':
      // The agents surface is itself a headless `EmptyState`; our PaneEmptyState
      // wraps it. The live agent chat is a Wave-3 feature (A1).
      return (
        <PaneEmptyState
          kicker="Pyric Agent · coming in Wave 3"
          title={tab.label}
          body={tab.blurb}
        />
      );
    case null:
      // Bespoke Wave-2/3 features with no headless surface yet.
      return (
        <PaneEmptyState
          kicker="Coming in a later wave"
          title={tab.label}
          body={tab.blurb}
        />
      );
  }
}
