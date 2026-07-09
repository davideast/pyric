/**
 * Workspace `RTDB` tab — the Firebase console / firebase-tools-ui data
 * viewer form, composed over `@pyric/ui/rtdb` (NOT reimplemented). Mirrors
 * Pyric Studio's `RtdbSurface` (`packages/studio/src/features/rtdb`):
 *
 *   - PATH BAR → `RtdbPathBar`: the sandbox label + current path as
 *     clickable crumbs; the pencil (or Enter/Escape in the input) edits the
 *     path directly.
 *   - TREE → `RtdbTree` over `useRtdbTree`: expandable nodes, `key: value`
 *     leaves with click-to-edit, hover-revealed `+`/`x` per node with an
 *     inline delete confirm (no modals), console-style paging at 50
 *     children per level.
 *
 * Backend: the playground's existing sandbox runtime seam
 * (`~/lib/sandbox/runtime`) — `readDatabaseState` / `adminSetDatabaseValue` /
 * `adminDeleteDatabaseValue`, the same admin-lens ops the old hand-rolled
 * RTDB tab used. This is an admin panel (Firebase Console-style), so writes
 * bypass rules like the Firestore tab does. There is no push-subscription
 * primitive on the runtime seam, so `RtdbApi.subscribeValue` is composed
 * from the seam's existing pieces: an initial `readDatabaseState()` plus a
 * live re-fetch on every `subscribeEvents` tick (the same event stream
 * `useDenialCapture` rides for the Traffic panel) — realtime without
 * inventing a new backend primitive.
 *
 * Styling lives in `global.css`'s `[data-rtdb-*]` block, targeting the
 * headless contract `@pyric/ui/rtdb` emits (mirrors the Firestore/Auth tab
 * skinning approach: zero `@pyric/ui` CSS overridden here).
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { RtdbPathBar, RtdbTree, rtdbValueAt, useRtdbTree, type RtdbApi } from '@pyric/ui/rtdb';
import {
  adminDeleteDatabaseValue,
  adminSetDatabaseValue,
  getPlaygroundRuntime,
  getPlaygroundSandboxMode,
  readDatabaseState,
  subscribePlaygroundSandboxMode,
} from '~/lib/sandbox/runtime';

export function RtdbTab() {
  const [path, setPath] = useState('/');

  // The playground has no per-instance slug the way Studio's shared
  // sandbox does — the identity a session cares about here is which
  // runtime it's on (shared Studio sandbox vs. this session's own
  // isolated runtime), so the root crumb echoes that.
  const sandboxMode = useSyncExternalStore(
    subscribePlaygroundSandboxMode,
    getPlaygroundSandboxMode,
    getPlaygroundSandboxMode,
  );
  const instanceLabel = `${sandboxMode}-sandbox`;

  const api = useMemo<RtdbApi>(() => buildRtdbApi(), []);
  const tree = useRtdbTree(api, path);

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="rtdb flex min-h-0 flex-1 flex-col">
        <RtdbPathBar
          className="rtdb__pathbar"
          path={path}
          onNavigate={setPath}
          rootLabel={instanceLabel}
          inputPrefix={instanceLabel}
        />
        <RtdbTree
          className="rtdb__tree"
          tree={tree}
          api={api}
          onNavigate={setPath}
          rootLabel={instanceLabel}
        />
      </div>
    </div>
  );
}

/**
 * Adapts the runtime seam into `RtdbApi`. `subscribeValue` fans a single
 * `readDatabaseState()` (full-tree admin read — the seam has no shallow/path
 * read) out to every path a mounted node cares about: one shared poll on
 * subscribe + on every sandbox event, each subscriber re-derives its own
 * path's value with `rtdbValueAt`. Keeps the seam single-flight regardless
 * of how many tree nodes are subscribed.
 */
function buildRtdbApi(): RtdbApi {
  type Listener = { path: string; next: (value: unknown) => void; error?: (err: unknown) => void };
  const listeners = new Set<Listener>();
  let unsubscribeEvents: (() => void) | null = null;

  const refresh = () => {
    void readDatabaseState()
      .then((snapshot) => {
        for (const listener of listeners) {
          listener.next(rtdbValueAt(snapshot, listener.path));
        }
      })
      .catch((err) => {
        for (const listener of listeners) listener.error?.(err);
      });
  };

  return {
    set: (path, value) => adminSetDatabaseValue(path, value),
    remove: (path) => adminDeleteDatabaseValue(path),
    subscribeValue: (path, next, error) => {
      const listener: Listener = { path, next, error };
      listeners.add(listener);
      if (!unsubscribeEvents) {
        unsubscribeEvents = getPlaygroundRuntime().subscribeEvents(() => refresh());
      }
      void readDatabaseState()
        .then((snapshot) => next(rtdbValueAt(snapshot, path)))
        .catch((err) => error?.(err));
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeEvents) {
          unsubscribeEvents();
          unsubscribeEvents = null;
        }
      };
    },
  };
}
