/**
 * rules-cross-doc-get: rules use get() to read a separate doc as
 * part of a write check. Verifies cross-document rule evaluation
 * in the simulator.
 *
 * Scenario: a "members" doc lists which uids may write to "shared".
 * The rule reads members/{uid} and allows write only if found.
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "rules-cross-doc-get";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const sharedRef = doc(db, "shared", "note");

        // Attempt to write before being a member — should be denied.
        let denied = false;
        try {
          await setDoc(sharedRef, { body: "first attempt" });
        } catch { denied = true; }
        assert(denied, "write should be denied before membership");
        say("pre-membership write correctly denied");

        // Become a member. Membership doc is owner-only (any auth user
        // can grant themselves membership in this toy scenario).
        await setDoc(doc(db, "members", a.user.uid), { joinedAt: Date.now() });
        say("granted self membership");

        // Retry the write — should now succeed.
        await setDoc(sharedRef, { body: "after membership", author: a.user.uid });
        const snap = await getDoc(sharedRef);
        const body = (snap.data() as { body: string }).body;
        assert(body === "after membership", `body should match (got ${body})`);
        say("post-membership write succeeded");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
