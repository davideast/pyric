/**
 * rtdb-set-get-roundtrip: anonymous sign-in, then a write+read+remove
 * cycle against the `firebase/database` modular surface aliased to
 * `@pyric/rtdb` in the playground preview (Phase 3 Tier 5).
 *
 * Verifies the canonical app-code shape:
 *   - bare `getDatabase()` defaults to the runner's sandbox in preview
 *   - `set(ref(db, path), value)` round-trips through `get(ref)`
 *   - `remove(ref)` clears the path; subsequent `get` returns
 *     `exists() === false` and `val() === null`
 */
import { useEffect, useState } from "react";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get, remove } from "firebase/database";

const NAME = "rtdb-set-get-roundtrip";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        const a = await signInAnonymously(auth);
        say(`signed in as ${a.user.uid}`);

        // Bare getDatabase() — the preview wraps the call to default
        // to the runner's sandbox so app code stays portable.
        const db = getDatabase();
        const greetingRef = ref(db, `greetings/${a.user.uid}`);

        await set(greetingRef, "world");
        const snap = await get(greetingRef);
        assert(snap.exists(), "expected snap.exists() === true after set");
        assert(snap.val() === "world", `expected snap.val() === 'world', got ${JSON.stringify(snap.val())}`);
        say("set + get round-trip ok");

        await remove(greetingRef);
        const after = await get(greetingRef);
        assert(!after.exists(), "expected snap.exists() === false after remove");
        assert(after.val() === null, `expected snap.val() === null after remove, got ${JSON.stringify(after.val())}`);
        say("remove ok");

        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
