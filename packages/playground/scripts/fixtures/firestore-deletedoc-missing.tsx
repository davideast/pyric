/**
 * firestore-deletedoc-missing: `deleteDoc` against a non-existent
 * doc must resolve cleanly with no throw and no side effects.
 * Matches production `firebase/firestore` semantics. Pins matrix
 * row Firestore #39.
 *
 * Empirical oracle:
 *   packages/conformance/observations/firestore/firestore-deletedoc-missing.json
 * (`threw: false` against blockingfun, fb-js-sdk 12.13.0).
 */
import { useEffect, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-deletedoc-missing";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        // Rule (deployed via fixture sibling .rules) requires
        // signed-in auth; sign in anonymously so the call clears
        // rules. Any rule-denial is a different test concern.
        const auth = getAuth();
        await signInAnonymously(auth);

        // Deleting a doc that never existed must be a clean no-op.
        const ghost = doc(collection(db, "tickets"), "never-existed");
        await deleteDoc(ghost);
        say("deleteDoc on never-existed resolved without throwing");

        // Idempotency: write a doc, delete it, then delete again.
        // The second delete should also be a clean no-op.
        const t1 = doc(collection(db, "tickets"), "T-1");
        await setDoc(t1, { title: "doomed" });
        await deleteDoc(t1);
        const snap = await getDoc(t1);
        assert(!snap.exists(), "doc should be gone after first delete");
        await deleteDoc(t1);
        say("second deleteDoc against the now-missing path was also a no-op");

        // No side effects: an unrelated sibling survives.
        const keep = doc(collection(db, "tickets"), "T-keep");
        await setDoc(keep, { title: "keep me" });
        await deleteDoc(doc(collection(db, "tickets"), "ghost-2"));
        const sib = await getDoc(keep);
        assert(sib.exists(), "sibling must still exist after delete-missing");
        const sibData = sib.data() as { title?: string } | undefined;
        assert(sibData?.title === "keep me", `sibling unchanged (got ${sibData?.title})`);
        say("delete-missing left unrelated docs untouched");

        // WriteBatch.delete on a missing doc commits cleanly.
        const batch = writeBatch(db);
        batch.delete(doc(collection(db, "tickets"), "ghost-3"));
        batch.set(doc(collection(db, "tickets"), "T-new"), { title: "born" });
        await batch.commit();
        const newSnap = await getDoc(doc(collection(db, "tickets"), "T-new"));
        assert(newSnap.exists(), "batch sibling write must have committed");
        say("WriteBatch.delete on missing doc committed alongside a sibling set");

        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
