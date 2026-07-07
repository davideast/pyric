/**
 * Pane renderer (T4).
 *
 * Each tab routes to a pane. Tabs backed by a `@pyric/ui` area mount that
 * surface (see `panes.tsx`); those components are pure-props and render an
 * empty state with no live handle, so they're on screen today and fill with
 * data once T3's local backend resolves the env. Tabs with no `@pyric/ui`
 * surface (Action Center, Rules, App Builder) carry a Wave-2/3 feature and show
 * a feature-preview empty state.
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
import { findTab } from '../shell/tabs.js';

export function Pane({ tabId }: { tabId: string }) {
  const tab = findTab(tabId);

  switch (tab.area) {
    case 'firestore':
      return <FirestorePane />;
    case 'auth':
      return <AuthPane />;
    case 'storage':
      return <StoragePane />;
    case 'traffic':
      return <TrafficPane />;
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
