import { policyMemberIds } from "./authored-policy";
import { doc, runTransaction, type Firestore } from "firebase/firestore";
import {
  checkPolicy,
  policyCase,
  PolicyError,
  type Policy,
  type Members,
} from "./app-policy";
export async function writePolicyRecord(
  db: Firestore,
  base: string,
  appId: string,
  versionId: string | null | undefined,
  uid: string,
  sessionValid: () => boolean,
  op: "set" | "delete",
  id: string,
  data?: Record<string, unknown>,
) {
  if (!navigator.onLine)
    throw new PolicyError("backend", "Reconnect before changing this app.");
  try {
    await runTransaction(db, async (tx) => {
      if (!sessionValid())
        throw new PolicyError(
          "session",
          "Your session changed. Reopen the app.",
        );
      const root = await tx.get(doc(db, base + "/apps/" + appId));
      if (!root.exists() || root.data().deletedAt)
        throw new PolicyError("stale-version", "This app is unavailable.");
      const current = root.data();
      if (
        (current.policyRequired || current.policy) &&
        current.activeVersionId !== versionId
      )
        throw new PolicyError(
          "stale-version",
          "A different version is active. Reopen the app.",
        );
      const ref = doc(db, base + "/apps/" + appId + "/records/" + id);
      const before = await tx.get(ref);
      const members: Members = {};
      const dependencyIds = current.policy
        ? policyMemberIds(current.policy as Policy, uid, before.data(), data)
        : [uid];
      for (const memberId of dependencyIds) {
        if (!memberId || memberId.includes("/")) continue;
        const snap = await tx.get(doc(db, base + "/members/" + memberId));
        if (snap.exists()) members[memberId] = snap.data();
      }
      const proposed =
        current.policy?.format === 1 &&
        before.exists() &&
        members[uid]?.role === "parent" &&
        op === "set"
          ? { ...before.data(), ...data }
          : data;
      if (current.policyRequired || current.policy)
        checkPolicy(
          current.policy as Policy,
          policyCase(
            op === "delete" ? "delete" : before.exists() ? "update" : "create",
            uid,
            members,
            before.data(),
            proposed,
            "ALLOW",
            base.split("/")[1],
            appId,
            id,
          ),
        );
      if (!sessionValid())
        throw new PolicyError(
          "session",
          "Your session changed. Reopen the app.",
        );
      if (op === "delete") tx.delete(ref);
      else tx.set(ref, proposed!);
    });
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    throw new PolicyError(
      "backend",
      "The change could not be saved. Try again.",
      String(e),
    );
  }
}
