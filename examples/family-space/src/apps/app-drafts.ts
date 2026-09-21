import type { FamilyApp } from "./generation/generation-types";
import { doc, getDoc, runTransaction } from "firebase/firestore";
import { db, base } from "../data";
export type AppDraft = {
  title: string;
  prompt: string;
  audience: string[];
  revision: number;
  baseVersionId: string | null;
  status: "editing" | "building" | "ready" | "failed";
  latestBuildId: string | null;
  updatedAt: number;
};
export const appRef = (id: string) => doc(db, `${base}/apps/${id}`);
export const draftRef = (id: string) =>
  doc(db, `${base}/apps/${id}/drafts/main`);
export async function readDraft(id: string) {
  const snapshot = await getDoc(draftRef(id));
  return snapshot.exists() ? (snapshot.data() as AppDraft) : null;
}
export async function saveAppDraft(
  id: string,
  uid: string,
  value: AppDraft,
  expected: number,
) {
  await runTransaction(db, async (tx) => {
    const app = await tx.get(appRef(id)),
      draft = await tx.get(draftRef(id));
    if (app.exists() && (app.data().ownerId !== uid || app.data().deletedAt))
      throw new Error("This app is unavailable.");
    if ((draft.exists() ? draft.data().revision : 0) !== expected)
      throw new Error(
        "This draft changed in another tab. Reopen it before editing. Your text is saved on this device.",
      );
    if (!app.exists())
      tx.set(appRef(id), {
        ownerId: uid,
        title: value.title || "Untitled app",
        prompt: "",
        source: "",
        context: "{}",
        audience: [uid],
        createdAt: Date.now(),
        published: false,
        activeVersionId: null,
        deletedAt: null,
      });
    else if (!app.data().source)
      tx.update(appRef(id), { title: value.title || "Untitled app" });
    tx.set(draftRef(id), {
      ...value,
      revision: expected + 1,
      updatedAt: Date.now(),
    });
  });
  return expected + 1;
}

/** Include recovery journals whose first Firestore write was interrupted. */
export function localDraftApps(uid: string): FamilyApp[] {
  const prefix = `kin:draft:${uid}:`;
  const apps = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const { value } = JSON.parse(localStorage.getItem(key)!);
      apps.push({
        id: key.slice(prefix.length),
        ownerId: uid,
        title: value.title || "Untitled app",
        prompt: value.prompt || "",
        source: "",
        context: "{}",
        audience: [uid],
        createdAt: value.updatedAt || Date.now(),
        published: false,
      });
    } catch {
      /* Keep malformed journals for manual recovery. */
    }
  }
  return apps;
}
