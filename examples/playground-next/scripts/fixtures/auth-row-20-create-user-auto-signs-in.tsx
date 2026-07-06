/**
 * Pins matrix row Auth #20.
 *
 * Single claim: `createUserWithEmailAndPassword` auto-signs the new
 * user in — `auth.currentUser` becomes the new user immediately on
 * resolution.
 */
import { useEffect, useState } from "react";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";

const NAME = "auth-row-20-create-user-auto-signs-in";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        assert(auth.currentUser === null, "precondition: no current user before createUser");
        const created = await createUserWithEmailAndPassword(auth, "row20@example.com", "p@ss");
        assert(auth.currentUser !== null, "currentUser should be non-null after createUser");
        assert(
          auth.currentUser?.uid === created.user.uid,
          `currentUser.uid should equal created uid ${created.user.uid} (got ${String(auth.currentUser?.uid)})`,
        );
        say("createUser auto-signed the new user in");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
