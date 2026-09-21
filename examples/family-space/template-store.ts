import { chorePolicy } from "./app-policy";
import {
  collection,
  doc,
  getDocs,
  runTransaction,
  setDoc,
} from "firebase/firestore";
import { base, db, type Member, type Post } from "./data";
import { familyAppContext } from "./app-context";
import type { FamilyApp } from "./generation-types";
export type AppTemplate = {
  id: string;
  title: string;
  description: string;
  tone: "practical" | "fun";
  prompt: string;
  source: string;
  version: number;
};
export async function loadTemplates(parent: boolean): Promise<AppTemplate[]> {
  const source = collection(db, base + "/appTemplates");
  const read = async () =>
    (await getDocs(source)).docs.map(
      (d) => ({ ...d.data(), id: d.id }) as AppTemplate,
    );
  let saved = await read();
  if (parent) {
    const response = await fetch("/app-templates.json");
    if (!response.ok)
      throw new Error("Templates could not be loaded. Try again.");
    const shipped: AppTemplate[] = await response.json();
    const missing = shipped.filter((t) => !saved.some((s) => s.id === t.id));
    if (missing.length) {
      await runTransaction(db, async (tx) => {
        const snapshots = await Promise.all(
          missing.map((t) => tx.get(doc(source, t.id))),
        );
        missing.forEach((t, i) => {
          if (!snapshots[i].exists()) {
            const { id, ...data } = t;
            tx.set(doc(source, id), data);
          }
        });
      });
      saved = await read();
    }
  }
  return saved.sort((a, b) => a.title.localeCompare(b.title));
}
export async function useTemplate(
  template: AppTemplate,
  member: Member,
  members: Member[],
  posts: Post[],
  selected: string[],
): Promise<FamilyApp> {
  if (member.role !== "parent")
    throw new Error("Only parents can create apps.");
  const audience = [
    ...new Set([
      member.id,
      ...selected.filter((id) => members.some((m) => m.id === id)),
    ]),
  ];
  const app: FamilyApp = {
    id: crypto.randomUUID(),
    ...(template.id === "chore-quest"
      ? { policy: chorePolicy, policyRequired: true }
      : {}),
    ownerId: member.id,
    title: template.title,
    prompt: template.prompt,
    source: template.source,
    context: JSON.stringify(familyAppContext(members, posts, [], audience)),
    audience,
    createdAt: Date.now(),
    published: false,
  };
  const { id, ...data } = app;
  await setDoc(doc(db, base + "/apps/" + id), data);
  return app;
}
