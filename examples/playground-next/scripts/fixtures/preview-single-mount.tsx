/**
 * preview-single-mount: the playground must mount the user's
 * component exactly once per session load. The previous shape rendered
 * both Workspace's `AppPreview` AND the mobile `AppPanel`'s `AppPreview`
 * unconditionally — the latter `md:hidden` on desktop but still
 * mounted, so two parallel React trees + two iframes each ran the
 * user's `useEffect` independently. Observer subscriptions
 * (`onAuthStateChanged`, `onSnapshot`, …) doubled up in the sandbox
 * and never unsubscribed.
 *
 * Pins matrix row Firestore #90 — preview tree must not leak
 * observers across re-mounts. The probe counts mount events in a
 * window-scoped counter so a SECOND mount (from a parallel iframe)
 * is detected even after the first mount's IIFE has already logged
 * DONE. We wait long enough for any second mount's effects to
 * actually run before asserting.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

const NAME = "preview-single-mount";

interface MountWindow {
  __pyricPreviewMountCount?: number;
  __pyricPreviewAuthFires?: number;
}

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    // Each iframe is same-origin and shares the parent window via
    // the playground's `IframePreview`. Increment a window-scoped
    // counter so a SECOND mount (from a sibling AppPreview tree)
    // bumps the same value the FIRST mount reads. A leak shows up
    // as `>= 2` after the wait below.
    const w = window as MountWindow;
    w.__pyricPreviewMountCount = (w.__pyricPreviewMountCount ?? 0) + 1;
    const mountId = w.__pyricPreviewMountCount;

    const auth = getAuth();
    const fires: Array<string> = [];
    const unsub = onAuthStateChanged(auth, (u) => {
      fires.push(u ? u.uid : "null");
      w.__pyricPreviewAuthFires = (w.__pyricPreviewAuthFires ?? 0) + 1;
    });

    void (async () => {
      try {
        // Sign in then wait long enough that a second parallel mount
        // (if it existed) would also subscribe + fire + log. 300ms is
        // well past the debounce + compile + iframe load for any
        // sibling AppPreview.
        await signInAnonymously(auth);
        await new Promise((r) => setTimeout(r, 300));

        const totalMounts = w.__pyricPreviewMountCount ?? 0;
        say(`mountId=${mountId} totalMounts=${totalMounts} ownFires=${fires.length}`);

        // The first mount carries the assertion. A second mount would
        // re-enter this effect, re-subscribe, and run its own IIFE —
        // we'd see `totalMounts >= 2` and DONE would log twice.
        assert(
          mountId === 1,
          `expected first-mount path (mountId === 1), got mountId=${mountId}`,
        );
        assert(
          totalMounts === 1,
          `expected exactly one preview mount across the whole session, ` +
            `got totalMounts=${totalMounts} — the playground is leaking ` +
            `AppPreview instances (see Firestore #90 in packages/firestore/COMPAT.md)`,
        );
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      } finally {
        unsub();
      }
    })();

    return () => { unsub(); };
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
