/**
 * firestore-batch: writeBatch commits multiple ops atomically. Tests
 * batch ergonomics + that all docs become visible after commit.
 */
import { useEffect, useState } from "react";
import { collection, doc, getDocs, query, where, writeBatch } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-batch";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const tasks = collection(db, "tasks");

        const batch = writeBatch(db);
        for (let i = 0; i < 4; i++) {
          batch.set(doc(tasks, `t${i}`), { owner: a.user.uid, idx: i, done: false });
        }
        await batch.commit();

        const snap = await getDocs(query(tasks, where("owner", "==", a.user.uid)));
        assert(snap.size === 4, `expected 4 tasks, got ${snap.size}`);
        say(`batch committed ${snap.size} tasks`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
