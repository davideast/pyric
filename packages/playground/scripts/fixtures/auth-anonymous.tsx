/**
 * auth-anonymous: anonymous sign-in + own-profile CRUD + sign-out
 * cycle. Verifies the canonical anonymous flow end-to-end.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

const NAME = "auth-anonymous";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    const auth = getAuth();
    const fires: Array<string> = [];
    const unsub = onAuthStateChanged(auth, (u) => fires.push(u ? u.uid : "null"));
    void (async () => {
      try {
        const a = await signInAnonymously(auth);
        assert(a.user.isAnonymous, "expected isAnonymous=true");
        assert(a.user.email === null, "expected email=null");
        say(`signed in as ${a.user.uid}`);

        await setDoc(doc(db, "users", a.user.uid), {
          uid: a.user.uid, anon: true, createdAt: serverTimestamp(),
        });
        const snap = await getDoc(doc(db, "users", a.user.uid));
        assert(snap.exists, "profile doc should exist after write");
        const data = snap.data() as { uid: string } | undefined;
        assert(data?.uid === a.user.uid, `profile.uid should equal ${a.user.uid}`);
        say("profile read OK");

        await signOut(auth);
        assert(auth.currentUser === null, "currentUser should be null after signOut");

        // Reuse semantics: second anonymous sign-in after a signOut should mint
        // a different uid (matches firebase/auth — signOut clears persistence).
        const b = await signInAnonymously(auth);
        assert(b.user.uid !== a.user.uid, "second anon sign-in after signOut should mint a fresh uid");
        say(`signed in again as ${b.user.uid}`);

        // Listener should see exactly the 3 state transitions:
        //   anon-1 (from signInAnonymously), null (from signOut), anon-2.
        // The initial-null subscribe-replay is suppressed by the dedup
        // path in `@pyric/auth` (PR #399) because signInAnonymously
        // fires the same observer synchronously before the microtask
        // gets to run — that fire wins, the microtask is skipped.
        assert(fires.length === 3, `expected 3 fires, got ${fires.length}: ${fires.join(",")}`);
        unsub();
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { unsub(); };
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
