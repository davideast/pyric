/**
 * firestore-bare-getfirestore: regression for PR #397. The agent
 * frequently writes `const db = getFirestore();` instead of importing
 * the virtual `db` from "./firebase". Before the wrap fix, this fell
 * through to real firebase/firestore and threw `app/no-app`.
 */
import { useEffect, useState } from "react";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

const NAME = "firestore-bare-getfirestore";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        // Bare getFirestore() — the buggy shape that PR #397 fixed.
        const localDb = getFirestore();
        const auth = getAuth();
        const a = await signInAnonymously(auth);

        await setDoc(doc(localDb, "users", a.user.uid), {
          uid: a.user.uid, createdAt: serverTimestamp(),
        });
        const snap = await getDoc(doc(localDb, "users", a.user.uid));
        assert(snap.exists, "doc should exist after setDoc");
        const data = snap.data() as { uid?: string } | undefined;
        assert(data?.uid === a.user.uid, `uid mismatch (got ${data?.uid})`);
        say("bare getFirestore() works — no app/no-app");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
