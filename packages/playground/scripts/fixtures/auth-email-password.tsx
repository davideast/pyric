/**
 * auth-email-password: create user, write profile, sign-out, sign-in
 * with same credentials, verify uid persists across sign-out cycle.
 */
import { useEffect, useState } from "react";
import {
  getAuth, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

const NAME = "auth-email-password";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    const auth = getAuth();
    void (async () => {
      try {
        const created = await createUserWithEmailAndPassword(auth, "bob@example.com", "p@ss");
        assert(created.user.email === "bob@example.com", "email should match input");
        assert(created.user.isAnonymous === false, "createUser should not be anonymous");
        const uid = created.user.uid;
        say(`created uid=${uid}`);

        await setDoc(doc(db, "users", uid), { uid, email: created.user.email, createdAt: serverTimestamp() });
        const written = await getDoc(doc(db, "users", uid));
        assert(written.exists, "profile should exist after write");

        await signOut(auth);
        assert(auth.currentUser === null, "currentUser should be null after signOut");

        const reSigned = await signInWithEmailAndPassword(auth, "bob@example.com", "p@ss");
        assert(reSigned.user.uid === uid, `signing back in should restore same uid (got ${reSigned.user.uid})`);
        say(`signed back in with same uid`);

        // Wrong password should reject.
        let denied = false;
        try {
          await signInWithEmailAndPassword(auth, "bob@example.com", "wrong");
        } catch { denied = true; }
        assert(denied, "wrong password should throw");
        say("wrong password rejected");

        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
