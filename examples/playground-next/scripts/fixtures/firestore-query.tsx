/**
 * firestore-query: where + orderBy + limit against a collection.
 * Tests the query path against owner-only rules (rules must permit
 * `list` on the collection prefix that owner-scoped docs share).
 */
import { useEffect, useState } from "react";
import {
  collection, query, where, orderBy, limit, getDocs, setDoc, doc, serverTimestamp,
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-query";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const items = collection(db, "items");

        // Seed 5 items with priority 1..5; owner = current uid.
        for (let i = 1; i <= 5; i++) {
          await setDoc(doc(items, `i${i}`), {
            owner: a.user.uid, priority: i, label: `item ${i}`, createdAt: serverTimestamp(),
          });
        }

        // Query: owner == me, priority >= 3, ordered desc, limit 2.
        const q = query(
          items,
          where("owner", "==", a.user.uid),
          where("priority", ">=", 3),
          orderBy("priority", "desc"),
          limit(2),
        );
        const snap = await getDocs(q);
        assert(snap.size === 2, `expected 2 docs, got ${snap.size}`);
        const priorities = snap.docs.map((d) => (d.data() as { priority: number }).priority);
        assert(JSON.stringify(priorities) === JSON.stringify([5, 4]), `expected [5,4], got ${priorities.join(",")}`);
        say(`query returned ${priorities.join(",")}`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
