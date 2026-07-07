/**
 * rules-data-validation: rules check request.resource.data shape +
 * field constraints. Valid writes pass; invalid writes deny.
 */
import { useEffect, useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "rules-data-validation";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = (id: string) => doc(db, "orders", id);

        // Valid: has author, has price < 1000, has nonempty itemId.
        await setDoc(ref("ok-1"), { author: a.user.uid, price: 99, itemId: "burger" });
        say("valid write allowed");

        // Invalid: price too high.
        let denied1 = false;
        try { await setDoc(ref("bad-1"), { author: a.user.uid, price: 5000, itemId: "burger" }); } catch { denied1 = true; }
        assert(denied1, "price>=1000 should be denied");

        // Invalid: missing itemId.
        let denied2 = false;
        try { await setDoc(ref("bad-2"), { author: a.user.uid, price: 50 }); } catch { denied2 = true; }
        assert(denied2, "missing itemId should be denied");

        // Invalid: author != caller.
        let denied3 = false;
        try { await setDoc(ref("bad-3"), { author: "someone-else", price: 50, itemId: "burger" }); } catch { denied3 = true; }
        assert(denied3, "wrong author should be denied");

        say("all 3 invalid writes denied");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
