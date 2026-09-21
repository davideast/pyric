import { retryWorkflow } from "./build-workflow";
import { buildRepository } from "./build-tab-services";
import { initialWorkflow } from "./build-workflow-types";
import { generationModelOptions } from "./generation-model";
import {
  beginBuild,
  recordBuild,
  saveGeneratedVersion,
  ensureAppVersion,
} from "../app-versions";
import { readDraft, saveAppDraft } from "../app-drafts";
import { loadUiKit } from "../ui-kit/ui-kit-store";
import { onAuthStateChanged } from "firebase/auth";
import { useSyncExternalStore } from "react";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  limit,
  orderBy,
  query,
  setDoc,
  runTransaction,
  where,
  updateDoc,
} from "firebase/firestore";
import {
  auth,
  base,
  db,
  type Member,
  type Post,
  type ChatMessage,
} from "../../data";
import { familyAppContext } from "../runtime/app-context";
import { generationClient, generationControl } from "./durable-generation";
import type {
  FamilyApp,
  GenerationJob,
  GenerationSpec,
  DurableGeneration,
} from "./generation-types";
export type {
  FamilyApp,
  GenerationJob,
  GenerationEvent,
} from "./generation-types";

let job: GenerationJob | null = null,
  attachedId: string | undefined;
let subscription: AbortController | undefined;
let currentSpec: GenerationSpec | undefined;
let persistence = Promise.resolve();
let identity: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const key = (uid: string) => `kin:generation:${uid}`;
export function useGeneration() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => job,
  );
}
function showError(error: unknown) {
  if (job) {
    job = {
      ...job,
      state: "failed",
      error: String(error),
      events: [
        ...job.events.map((event) => ({ ...event, running: false })),
        {
          id: job.events.length,
          kind: "error",
          title: "Build needs attention",
          detail: String(error),
          running: false,
        },
      ],
    };
    emit();
    if (currentSpec && job && !currentSpec.workflow)
      void recordBuild(currentSpec, job).catch(() => {});
  }
}
async function locked<T>(uid: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "Resumable builds require Web Locks. Open Kin over HTTPS in a supported browser.",
    );
  return navigator.locks.request(key(uid), work);
}
function storePointer(uid: string, id: string) {
  localStorage.setItem(key(uid), id);
}
function clearView() {
  subscription?.abort();
  subscription = undefined;
  attachedId = undefined;
  job = null;
  emit();
}
export function dismissGeneration() {
  if (job?.state !== "running" && identity) {
    localStorage.removeItem(key(identity));
    clearView();
  }
}
export function stopGeneration() {
  if (attachedId) void generationControl("cancel", attachedId).catch(showError);
}

async function saveDraft(value: DurableGeneration, uid: string) {
  if (
    !value.job.draft ||
    value.job.state === "failed" ||
    value.job.state === "stopped" ||
    identity !== uid
  )
    return;
  await locked(uid, async () => {
    if (identity !== uid || auth.currentUser?.uid !== uid) return;
    let draft = value.job.draft!;
    let versionId = value.spec.buildId;
    if (!versionId) {
      // Jobs recorded before versioning have no build ID. Never replay their
      // source over a saved app, or recreate an app that was subsequently deleted.
      const owned = await getDocs(
        query(collection(db, base + "/apps"), where("ownerId", "==", uid)),
      );
      const saved = owned.docs.find((document) => document.id === draft.id);
      if (!saved || saved.data().deletedAt || !saved.data().source)
        throw new Error(
          "This older build has no available saved app. Its output remains in this activity log; dismiss it or start a new draft.",
        );
      draft = { id: saved.id, ...saved.data() } as FamilyApp;
      versionId = draft.activeVersionId ?? undefined;
    } else {
      await saveGeneratedVersion(value.spec, draft);
      await persistence;
      await recordBuild(value.spec, { ...value.job, state: "ready" });
    }
    if (identity !== uid) return;
    job = {
      ...value.job,
      draft,
      versionId,
      state: "ready",
      events: [
        ...value.job.events.map((e) => ({ ...e, running: false })),
        {
          id: value.job.events.length,
          kind: "result",
          title: "Your app is ready",
          detail: "Open it to try it out, then share it with your family.",
          running: false,
        },
      ],
    };
    emit();
  });
}
async function attach(id: string, uid: string) {
  if (attachedId === id) return;
  subscription?.abort();
  const abort = new AbortController();
  subscription = abort;
  attachedId = id;
  try {
    for await (const event of generationClient().subscribe(id, {
      signal: abort.signal,
    })) {
      if (abort.signal.aborted || identity !== uid) return;
      if (event.kind === "event") {
        if (event.value.job.ownerId !== uid)
          throw new Error("This build belongs to another identity.");
        currentSpec = event.value.spec;
        job = event.value.job;
        persistence = persistence
          .then(() =>
            event.value.spec.workflow
              ? recordWorkflowEvents(event.value.spec, event.value.job)
              : recordBuild(event.value.spec, event.value.job),
          )
          .catch(showError);
        emit();
        if (!event.value.spec.workflow && job.draft && job.state !== "stopped")
          void saveDraft(event.value, uid).catch(showError);
      } else if (event.status === "error" && job) {
        showError(event.reason ?? "Build interrupted");
      }
    }
  } catch (error) {
    if (!abort.signal.aborted && identity === uid) showError(error);
  }
}
const eventCache = new Map<string, string>();
async function recordWorkflowEvents(
  spec: GenerationSpec,
  value: GenerationJob,
) {
  for (const event of value.events) {
    const key = `${spec.buildId}/${event.id}`,
      text = JSON.stringify(event);
    if (eventCache.get(key) === text) continue;
    if (auth.currentUser?.uid !== spec.ownerId) return;
    await setDoc(
      doc(
        db,
        `${base}/apps/${spec.id}/builds/${spec.buildId}/events/${event.id}`,
      ),
      event,
    );
    eventCache.set(key, text);
  }
}
async function restoreBuild(appId: string, buildId: string, uid: string) {
  const seed = { id: appId, buildId, ownerId: uid } as GenerationSpec;
  let restored: Awaited<ReturnType<typeof buildRepository.restore>>;
  try {
    restored = await buildRepository.restore(seed);
  } catch (error) {
    if (identity !== uid) return false;
    currentSpec = undefined;
    job = {
      id: appId,
      ownerId: uid,
      title: "Saved build",
      state: "failed",
      canResume: false,
      events: [],
      error: "The saved checkpoint could not be restored: " + String(error),
    };
    emit();
    return true;
  }
  if (!restored || identity !== uid) return false;
  currentSpec = {
    ...restored.state.spec,
    workflow: {
      state: restored.state,
      revision: restored.revision,
      lease: { executor: "", token: "", expiresAt: 0 },
    },
  };
  const events = (
    await getDocs(
      collection(db, `${base}/apps/${appId}/builds/${buildId}/events`),
    )
  ).docs
    .map((d) => d.data() as GenerationJob["events"][number])
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ ...e, running: false }));
  if (identity !== uid) return false;
  job = {
    id: appId,
    ownerId: uid,
    title: currentSpec.title,
    state: restoredJobState(restored.state.status),
    versionId: restored.state.status === "ready" ? buildId : undefined,
    events,
    error: restored.state.diagnostic,
  };
  emit();
  return true;
}
async function reconnect(uid: string) {
  try {
    const id = localStorage.getItem(key(uid));
    if (id) {
      const client = generationClient();
      const active = await generationControl("active", id);
      const snapshot = await client.get(id),
        last = snapshot?.events.at(-1);
      if (last?.job.ownerId === uid) {
        if (active || last.job.state === "ready") {
          void attach(id, uid);
          return;
        }
        if (
          last.spec.buildId &&
          (await restoreBuild(last.spec.id, last.spec.buildId, uid))
        )
          return;
        currentSpec = last.spec;
        job = {
          ...last.job,
          state: "interrupted",
          events: last.job.events.map((e) => ({ ...e, running: false })),
        };
        emit();
        return;
      }
    }
    const found = await buildRepository.discover();
    if (identity !== uid) return;
    for (const build of found)
      if (await restoreBuild(build.appId, build.buildId, uid)) break;
  } catch (error) {
    showError(error);
  }
}
export async function resumeGeneration(retry = false) {
  const prior = currentSpec,
    uid = identity;
  if (!prior || !uid || job?.state === "running") return;
  try {
    if (!prior.workflow) {
      location.hash = `#apps/${prior.id}/draft`;
      return;
    }
    const restored = await buildRepository.restore(prior);
    if (!restored)
      throw Error(
        "No committed checkpoint is available. Start over from the saved draft.",
      );
    const state = restored.state;
    if (retry) retryWorkflow(state, true);
    const lease = await buildRepository.acquire(prior, crypto.randomUUID());
    const spec = {
      ...state.spec,
      previous: job ?? undefined,
      workflow: { state, revision: restored.revision, lease },
    };
    currentSpec = spec;
    const result = await generationClient().start(spec);
    if (identity !== uid) {
      await generationControl("cancel", result.jobId);
      return;
    }
    storePointer(uid, result.jobId);
    attachedId = undefined;
    void attach(result.jobId, uid);
  } catch (error) {
    showError(error);
  }
}
export async function openBuild(appId: string, buildId: string) {
  if (!identity) return;
  subscription?.abort();
  attachedId = undefined;
  await restoreBuild(appId, buildId, identity);
  location.hash = "#build";
}
onAuthStateChanged(auth, (user) => {
  const uid = user?.uid ?? null;
  if (uid === identity) return;
  // Signing out is explicit cancellation, unlike reload or closing a tab.
  if (identity && attachedId && job?.state === "running")
    void generationControl("cancel", attachedId);
  clearView();
  identity = uid;
  if (uid) void reconnect(uid);
});
window.addEventListener("storage", (event) => {
  if (identity && event.key === key(identity)) {
    if (event.newValue) void reconnect(identity);
    else clearView();
  }
});
export function startGeneration(input: {
  baseSource?: string;
  appId?: string;
  draftRevision?: number;
  baseVersionId?: string | null;
  member: Member;
  members: Member[];
  posts: Post[];
  audience: string[];
  title: string;
  prompt: string;
  repair?: { app: FamilyApp; error: string };
}) {
  if (job?.state === "running" || input.member.role !== "parent") return;
  if (input.repair && input.repair.app.ownerId !== input.member.id) return;
  currentSpec = undefined;
  const uid = input.member.id,
    id = input.appId ?? input.repair?.app.id ?? crypto.randomUUID();
  const title = input.title.trim() || input.prompt.trim().slice(0, 70);
  job = {
    id,
    ownerId: uid,
    title,
    state: "running",
    events: [
      {
        id: 0,
        kind: "context",
        title: "Gathering family context",
        detail: "",
        running: true,
      },
    ],
  };
  emit();
  void locked(uid, async () => {
    if (identity !== uid) return;
    await generationControl("active", "");
    const previous = localStorage.getItem(key(uid));
    if (previous) {
      if (await generationControl("active", previous)) {
        void reconnect(uid);
        return;
      }
    }
    let baseVersionId = input.baseVersionId ?? null;
    if (input.repair && !baseVersionId)
      baseVersionId = await ensureAppVersion(input.repair.app);
    let draftRevision = input.draftRevision;
    if (draftRevision === undefined) {
      const prior = await readDraft(id);
      draftRevision = await saveAppDraft(
        id,
        uid,
        {
          title,
          prompt: input.prompt,
          audience: input.audience,
          baseVersionId,
          revision: prior?.revision ?? 0,
          status: "editing",
          latestBuildId: null,
          updatedAt: Date.now(),
        },
        prior?.revision ?? 0,
      );
    }
    const buildId = crypto.randomUUID();
    currentSpec = {
      id,
      ownerId: uid,
      title,
      prompt: input.prompt,
      audience: input.audience,
      context: "{}",
      createdAt: Date.now(),
      buildId,
      draftRevision,
      baseVersionId,
    };
    await beginBuild(currentSpec);
    const chat = await getDocs(
      query(
        collection(db, base + "/chat"),
        orderBy("createdAt", "desc"),
        limit(40),
      ),
    );
    if (identity !== uid) return;
    const audience = [...new Set([uid, ...input.audience])];
    const context = JSON.stringify(
      familyAppContext(
        input.members,
        input.posts,
        chat.docs.map((d) => ({ ...d.data(), id: d.id }) as ChatMessage),
        audience,
      ),
    );
    const uiKit = await loadUiKit();
    if (identity !== uid) return;
    const root = await getDoc(doc(db, `${base}/apps/${id}`));
    const basePolicy = baseVersionId
      ? (
          await getDoc(
            doc(
              db,
              `${base}/apps/${id}/versions/${baseVersionId}/artifacts/policy`,
            ),
          )
        ).data()?.policy
      : null;
    const requiredPolicy =
      root.data()?.policy ?? basePolicy ?? input.repair?.app.policy ?? null;
    if (root.data()?.policyRequired && !requiredPolicy)
      throw new Error("This app is missing its required policy.");
    const spec: GenerationSpec = {
      policyWorkflow: 1,
      expectedActiveVersionId: root.data()?.activeVersionId ?? null,
      modelConfig: generationModelOptions,
      requiredPolicy,
      buildId,
      draftRevision,
      baseVersionId,
      ...(input.baseSource ? { baseSource: input.baseSource } : {}),
      uiKit,
      id,
      ownerId: uid,
      title,
      prompt: input.prompt,
      context: input.repair?.app.context ?? context,
      audience: input.repair?.app.audience ?? audience,
      createdAt: input.repair?.app.createdAt ?? Date.now(),
      ...(input.repair
        ? {
            repair: {
              source: input.repair.app.source,
              error: input.repair.error,
              revision: crypto.randomUUID(),
            },
          }
        : {}),
    };
    currentSpec = spec;
    await updateDoc(doc(db, `${base}/apps/${id}/builds/${buildId}`), {
      input: {
        title: spec.title,
        prompt: spec.prompt,
        context: spec.context,
        audience: spec.audience,
      },
    });
    const lease = await buildRepository.acquire(spec, crypto.randomUUID());
    const state = initialWorkflow(spec);
    const committed = await buildRepository.commit(spec, lease, 0, state);
    spec.workflow = { state, revision: committed.revision, lease };
    const result = await generationClient().start(spec);
    if (identity !== uid) {
      await generationControl("cancel", result.jobId);
      return;
    }
    storePointer(uid, result.jobId);
    void attach(result.jobId, uid);
  }).catch(showError);
}

function restoredJobState(
  status: import("./build-workflow-types").BuildStatus,
): GenerationJob["state"] {
  if (status === "ready") return "ready";
  if (status === "cancelled") return "stopped";
  if (status === "needs-attention") return "failed";
  return "interrupted";
}
