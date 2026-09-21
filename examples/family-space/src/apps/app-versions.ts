import { validatePolicy, type Policy } from "./policies/app-policy";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  deleteDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db, base } from "../data";
import { generationModelOptions } from "./generation/generation-model";
import { appRef, draftRef } from "./app-drafts";
import type {
  FamilyApp,
  GenerationSpec,
  GenerationJob,
} from "./generation/generation-types";
export type AppVersion = {
  id: string;
  number: number;
  title: string;
  prompt: string;
  audience: string[];
  baseVersionId: string | null;
  buildId: string;
  model: string;
  sourceHash: string;
  dataSchemaVersion: number;
  createdAt: number;
};
const versionRef = (id: string, v: string) =>
  doc(db, `${base}/apps/${id}/versions/${v}`);
const artifactRef = (id: string, v: string, kind: string) =>
  doc(db, `${base}/apps/${id}/versions/${v}/artifacts/${kind}`);
const digest = async (source: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
export async function ensureAppVersion(app: FamilyApp) {
  if (!app.source) return null;
  const hash = await digest(app.source);
  let evidence: Awaited<ReturnType<typeof validatePolicy>> | null = null;
  if (app.policy) {
    const members = Object.fromEntries(
      (await getDocs(collection(db, base + "/members"))).docs.map((d) => [
        d.id,
        d.data(),
      ]),
    );
    const records = (
      await getDocs(collection(db, base + "/apps/" + app.id + "/records"))
    ).docs.map((d) => ({ id: d.id, ...d.data() }));
    evidence = await validatePolicy(app.policy, records, members);
  }
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(appRef(app.id));
    if (!snap.exists()) throw new Error("App is unavailable");
    const current = snap.data();
    if (current.activeVersionId) return current.activeVersionId as string;
    if (current.source !== app.source)
      throw new Error("App changed. Reopen it.");
    const id = "initial";
    tx.set(versionRef(app.id, id), {
      number: 1,
      title: app.title,
      prompt: app.prompt,
      audience: app.audience,
      baseVersionId: null,
      buildId: "imported",
      model: "existing",
      sourceHash: hash,
      dataSchemaVersion: 1,
      createdAt: app.createdAt,
    });
    tx.set(artifactRef(app.id, id, "source"), {
      source: app.source,
      entrypoint: "App.tsx",
      runtimeContractVersion: 1,
    });
    if (app.policy) {
      tx.set(artifactRef(app.id, id, "policy"), { policy: app.policy });
      tx.set(artifactRef(app.id, id, "validation"), evidence!);
    }
    tx.set(artifactRef(app.id, id, "context"), {
      snapshot: app.context,
      capturedAt: app.createdAt,
      recipientIds: app.audience,
    });
    tx.update(appRef(app.id), {
      activeVersionId: id,
      ...(app.policy ? { policyRequired: true } : {}),
      versionCount: 1,
      deletedAt: null,
    });
    return id;
  });
}
export async function listVersions(id: string): Promise<AppVersion[]> {
  return (await getDocs(collection(db, `${base}/apps/${id}/versions`))).docs
    .map((d) => ({ id: d.id, ...d.data() }) as AppVersion)
    .sort((a, b) => b.number - a.number);
}
export async function readVersion(id: string, v: AppVersion) {
  const [source, context, policy, validation] = await Promise.all([
    getDoc(artifactRef(id, v.id, "source")),
    getDoc(artifactRef(id, v.id, "context")),
    getDoc(artifactRef(id, v.id, "policy")),
    getDoc(artifactRef(id, v.id, "validation")),
  ]);
  const sourceText = source.data()?.source;
  const contextText = context.data()?.snapshot;
  if (typeof sourceText !== "string" || !sourceText.trim())
    throw new Error(`Saved source for Version ${v.number} is missing.`);
  if (typeof contextText !== "string")
    throw new Error(`Saved context for Version ${v.number} is missing.`);
  return {
    ...v,
    policy: policy.data()?.policy as Policy | undefined,
    validation: validation.data(),
    source: sourceText,
    context: contextText,
  };
}
export async function saveGeneratedVersion(
  spec: GenerationSpec,
  app: FamilyApp,
) {
  const id = spec.buildId!;
  const hash = await digest(app.source);
  await runTransaction(db, async (tx) => {
    const root = await tx.get(appRef(app.id)),
      existing = await tx.get(versionRef(app.id, id)),
      draft = await tx.get(draftRef(app.id));
    if (!root.exists() || root.data().deletedAt)
      throw new Error("This app was deleted. The build cannot be saved.");
    if (spec.workflow) {
      const build = await tx.get(
        doc(db, `${base}/apps/${app.id}/builds/${id}`),
      );
      const lease = build.data()?.lease;
      if (
        auth.currentUser?.uid !== spec.ownerId ||
        lease?.token !== spec.workflow.lease.token ||
        lease.expiresAt <= Date.now()
      )
        throw Error("Build lease or identity changed.");
      if (
        !draft.exists() ||
        draft.data().revision !== spec.draftRevision ||
        draft.data().latestBuildId !== id
      )
        throw Error(
          "The draft changed. Start a new build from the current draft.",
        );
      if (
        (root.data().activeVersionId ?? null) !== spec.expectedActiveVersionId
      )
        throw Error(
          "The active version changed. Start a new build from the current draft.",
        );
    }
    if (existing.exists()) {
      if (spec.workflow) {
        const savedPolicy = await tx.get(artifactRef(app.id, id, "policy"));
        if (
          existing.data().sourceHash !== hash ||
          savedPolicy.data()?.policy?.resolved !== app.policy?.resolved
        )
          throw Error(
            "This build already saved a different candidate. Start a new build from your draft.",
          );
      }
      return;
    }
    const number = (root.data().versionCount ?? 0) + 1;
    tx.set(versionRef(app.id, id), {
      number,
      title: app.title,
      prompt: app.prompt,
      audience: app.audience,
      baseVersionId: spec.baseVersionId ?? null,
      buildId: id,
      model: spec.modelConfig?.model ?? generationModelOptions.model,
      sourceHash: hash,
      dataSchemaVersion: 1,
      createdAt: Date.now(),
    });
    tx.set(artifactRef(app.id, id, "source"), {
      source: app.source,
      entrypoint: "App.tsx",
      runtimeContractVersion: 1,
    });
    tx.set(artifactRef(app.id, id, "context"), {
      snapshot: app.context,
      capturedAt: Date.now(),
      recipientIds: app.audience,
    });
    const policy = app.policy ?? root.data().policy;
    if (spec.policyWorkflow && root.data().policyRequired && !policy)
      throw new Error("This app requires a policy.");
    if (policy) {
      tx.set(artifactRef(app.id, id, "policy"), { policy });
      if (spec.policyWorkflow) {
        const evidence = await validatePolicy(policy, [], {});
        tx.set(artifactRef(app.id, id, "validation"), {
          ...evidence,
          phase: "generation",
        });
      }
    }
    tx.update(appRef(app.id), { versionCount: number });
    if (
      draft.exists() &&
      draft.data().latestBuildId === id &&
      draft.data().revision === spec.draftRevision
    )
      tx.update(draftRef(app.id), { status: "ready" });
  });
  return id;
}
export async function activateVersion(
  appId: string,
  version: AppVersion,
  expected: string | null,
) {
  const artifact = await readVersion(appId, version);
  let evidence: Awaited<ReturnType<typeof validatePolicy>> | null = null;
  let recordRefs: ReturnType<typeof doc>[] = [];
  let memberRefs: ReturnType<typeof doc>[] = [];
  if (artifact.policy) {
    const members = Object.fromEntries(
      (await getDocs(collection(db, base + "/members"))).docs.map((d) => [
        d.id,
        d.data(),
      ]),
    );
    const docs = (
      await getDocs(collection(db, base + "/apps/" + appId + "/records"))
    ).docs;
    recordRefs = docs.map((d) => d.ref);
    memberRefs = Object.keys(members).map((id) =>
      doc(db, base + "/members/" + id),
    );
    const records = docs.map((d) => ({ id: d.id, ...d.data() }));
    evidence = await validatePolicy(artifact.policy, records, members);
  }
  await runTransaction(db, async (tx) => {
    const root = await tx.get(appRef(appId));
    if (!root.exists() || root.data().deletedAt)
      throw new Error("App is unavailable.");
    if ((root.data().activeVersionId ?? null) !== expected)
      throw new Error(
        "Another version was activated. Reopen the app before changing it.",
      );
    if ((root.data().policyRequired || root.data().policy) && !artifact.policy)
      throw new Error(
        "A protected app cannot activate a version without a policy.",
      );
    if (artifact.policy) {
      const saved = await Promise.all(recordRefs.map((ref) => tx.get(ref)));
      const members = await Promise.all(memberRefs.map((ref) => tx.get(ref)));
      evidence = await validatePolicy(
        artifact.policy,
        saved.filter((d) => d.exists()).map((d) => ({ id: d.id, ...d.data() })),
        Object.fromEntries(
          members.filter((d) => d.exists()).map((d) => [d.id, d.data()!]),
        ),
      );
      const proof = await tx.get(artifactRef(appId, version.id, "validation"));
      if (!proof.exists())
        tx.set(artifactRef(appId, version.id, "validation"), evidence!);
    }
    const widening = version.audience.some(
      (id) => !root.data().audience.includes(id),
    );
    tx.update(appRef(appId), {
      activeVersionId: version.id,
      ...(artifact.policy
        ? { policy: artifact.policy, policyRequired: true }
        : {}),
      title: version.title,
      prompt: version.prompt,
      audience: version.audience,
      source: artifact.source,
      context: artifact.context,
      published: widening ? false : root.data().published,
      updatedAt: Date.now(),
    });
  });
}
export async function trashApp(id: string) {
  await updateDoc(appRef(id), { deletedAt: Date.now(), published: false });
  if (auth.currentUser)
    localStorage.removeItem(`kin:draft:${auth.currentUser.uid}:${id}`);
}
export async function restoreApp(id: string) {
  await updateDoc(appRef(id), { deletedAt: null, published: false });
}
export async function purgeApp(id: string) {
  const root = await getDoc(appRef(id));
  if (!root.data()?.deletedAt) throw new Error("Move the app to Trash first.");
  for (const group of ["versions", "builds", "drafts", "records"]) {
    const entries = await getDocs(
      collection(db, `${base}/apps/${id}/${group}`),
    );
    for (const item of entries.docs) {
      if (group === "builds") {
        const checkpoints = await getDocs(
          collection(db, `${item.ref.path}/checkpoints`),
        );
        for (const checkpoint of checkpoints.docs) {
          const artifacts = await getDocs(
            collection(db, `${checkpoint.ref.path}/artifacts`),
          );
          for (const artifact of artifacts.docs) await deleteDoc(artifact.ref);
          await deleteDoc(checkpoint.ref);
        }
      }
      if (group === "versions" || group === "builds") {
        const sub = group === "versions" ? "artifacts" : "events";
        const children = await getDocs(
          collection(db, `${base}/apps/${id}/${group}/${item.id}/${sub}`),
        );
        for (const child of children.docs) await deleteDoc(child.ref);
      }
      await deleteDoc(item.ref);
    }
  }
  await deleteDoc(appRef(id));
}
export async function beginBuild(spec: GenerationSpec) {
  await runTransaction(db, async (tx) => {
    const root = await tx.get(appRef(spec.id)),
      draft = await tx.get(draftRef(spec.id));
    if (!root.exists() || root.data().deletedAt)
      throw new Error("App is unavailable.");
    if (!draft.exists() || draft.data().revision !== spec.draftRevision)
      throw new Error("The draft changed before generation started.");
    tx.set(doc(db, `${base}/apps/${spec.id}/builds/${spec.buildId}`), {
      state: "running",
      draftRevision: spec.draftRevision,
      baseVersionId: spec.baseVersionId ?? null,
      input: {
        title: spec.title,
        prompt: spec.prompt,
        context: spec.context,
        audience: spec.audience,
      },
      createdAt: Date.now(),
    });
    tx.update(draftRef(spec.id), {
      status: "building",
      latestBuildId: spec.buildId,
    });
  });
}
export async function recordBuild(spec: GenerationSpec, job: GenerationJob) {
  if (!spec.buildId) return;
  const root = await getDoc(appRef(spec.id));
  if (!root.exists() || root.data().deletedAt) return;
  const batch = writeBatch(db);
  batch.update(doc(db, `${base}/apps/${spec.id}/builds/${spec.buildId}`), {
    state: job.state,
    error: job.error ?? null,
    updatedAt: Date.now(),
    resultVersionId: job.draft ? spec.buildId : null,
    checkpoint: spec.checkpoint ?? null,
  });
  for (const event of job.events)
    batch.set(
      doc(
        db,
        `${base}/apps/${spec.id}/builds/${spec.buildId}/events/${event.id}`,
      ),
      event,
    );
  await batch.commit();
  if (job.state === "failed" || job.state === "stopped")
    await runTransaction(db, async (tx) => {
      const draft = await tx.get(draftRef(spec.id));
      if (
        draft.exists() &&
        draft.data().latestBuildId === spec.buildId &&
        draft.data().revision === spec.draftRevision
      )
        tx.update(draftRef(spec.id), { status: "failed" });
    });
}
