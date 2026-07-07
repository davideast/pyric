/**
 * rules-custom-claims: rules engine reads `request.auth.token.<claim>`
 * from the signed-in user's customClaims. Admin claim flips a write
 * from denied to allowed. Pins matrix row Firestore #132.
 *
 * Scenario: /admin-area/{id} requires `request.auth.token.admin == true`
 * to write. A civilian (no admin claim) is denied; the admin (seeded
 * with customClaims: { admin: true }) succeeds. Reads are open to any
 * authenticated user so the test can verify the stored doc.
 *
 * Uses `authSandbox.seedUsers()` (preview-only escape hatch on the
 * `firebase/auth` re-export) to pre-stage the two users with their
 * claims before signing them in via email/password.
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  getAuth,
  signOut,
  signInWithEmailAndPassword,
  sandbox as authSandbox,
} from "firebase/auth";
import { db } from "./firebase";

const NAME = "rules-custom-claims";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();

        // Pre-stage two users: one admin (custom claim), one civilian.
        // seedUsers is the sandbox test driver — preview-only, deploy
        // never sees this binding (see preview-scope.ts).
        authSandbox.seedUsers(auth, [
          {
            uid: "admin-1",
            email: "admin@example.com",
            password: "p",
            customClaims: { admin: true },
          },
          {
            uid: "civilian-1",
            email: "civilian@example.com",
            password: "p",
          },
        ]);
        say("seeded admin + civilian");

        // Sign in as the civilian first — admin claim is absent, so
        // the rule's `request.auth.token.admin == true` is false.
        const civilian = await signInWithEmailAndPassword(auth, "civilian@example.com", "p");
        assert(civilian.user.uid === "civilian-1", `civilian uid should be civilian-1 (got ${civilian.user.uid})`);
        say("signed in as civilian");

        let denied = false;
        try {
          await setDoc(doc(db, "admin-area", "secret"), { body: "from-civilian" });
        } catch { denied = true; }
        assert(denied, "civilian write to /admin-area/ should be denied");
        say("civilian write correctly denied");

        // Sign out, then sign in as the admin. Now the ID token carries
        // `admin: true` and the same rule allows the write.
        await signOut(auth);
        const admin = await signInWithEmailAndPassword(auth, "admin@example.com", "p");
        assert(admin.user.uid === "admin-1", `admin uid should be admin-1 (got ${admin.user.uid})`);
        say("signed in as admin");

        await setDoc(doc(db, "admin-area", "secret"), { body: "from-admin" });
        const written = await getDoc(doc(db, "admin-area", "secret"));
        assert(written.exists, "admin write should land");
        const body = (written.data() as { body: string }).body;
        assert(body === "from-admin", `stored body should be from-admin (got ${body})`);
        say("admin write succeeded");

        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
