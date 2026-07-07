/**
 * Pins matrix row Auth #23.
 *
 * Single claim: `createUserWithEmailAndPassword`'s created `User` has
 * `isAnonymous: false`, `email: <input>`, `displayName: null`.
 */
import { useEffect, useState } from "react";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";

const NAME = "auth-row-23-create-user-shape";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const created = await createUserWithEmailAndPassword(getAuth(), "row23@example.com", "p@ss");
        assert(created.user.isAnonymous === false, "isAnonymous should be false");
        assert(created.user.email === "row23@example.com",
          `email should be 'row23@example.com' (got ${String(created.user.email)})`);
        assert(created.user.displayName === null,
          `displayName should be null (got ${String(created.user.displayName)})`);
        say("created User shape matches spec");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
