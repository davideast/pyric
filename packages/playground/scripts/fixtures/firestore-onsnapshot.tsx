/**
 * firestore-onsnapshot: live updates fire on writes from the same
 * user. Tests the snapshot-listener path end-to-end.
 */
import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-onsnapshot";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    void (async () => {
      try {
        const auth = getAuth();
        const a = await signInAnonymously(auth);
        const ref = doc(db, "notes", a.user.uid);

        const snaps: Array<{ exists: boolean; v?: number }> = [];
        unsub = onSnapshot(ref, (s) => {
          const exists = typeof s.exists === "function" ? (s.exists as () => boolean)() : s.exists;
          const data = exists ? (s.data() as { v?: number } | undefined) : undefined;
          snaps.push({ exists: Boolean(exists), v: data?.v });
        });

        await new Promise((r) => setTimeout(r, 50));
        await setDoc(ref, { v: 1, createdAt: serverTimestamp() });
        await new Promise((r) => setTimeout(r, 50));
        await updateDoc(ref, { v: 2 });
        await new Promise((r) => setTimeout(r, 50));
        await updateDoc(ref, { v: 3 });
        await new Promise((r) => setTimeout(r, 100));

        // Initial fire (missing doc) + 3 writes.
        assert(snaps.length >= 4, `expected ≥4 snaps, got ${snaps.length}`);
        assert(snaps[0]?.exists === false, "first snap should be missing");
        assert(snaps[snaps.length - 1]?.v === 3, `last snap should have v=3 (got ${snaps[snaps.length - 1]?.v})`);
        say(`saw ${snaps.length} snaps, final v=${snaps[snaps.length - 1]?.v}`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      } finally {
        unsub?.();
      }
    })();
    return () => { unsub?.(); };
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
