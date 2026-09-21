import { diagnostic, diagnosticCode } from "../diagnostics/remote-diagnostics";
import { AppBuildHistory } from "./app-build-history";
import React, { useEffect, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { AppPreview } from "./runtime/app-preview";
import { appRef } from "./app-drafts";
import {
  ensureAppVersion,
  listVersions,
  readVersion,
  activateVersion,
  trashApp,
  type AppVersion,
} from "./app-versions";
import type { FamilyApp } from "./generation/generation-types";
import { stopGeneration, useGeneration } from "./generation/generation";
export function AppDetail({
  app,
  owner,
  onBack,
  onEdit,
  onRepair,
}: {
  app: FamilyApp;
  owner: boolean;
  onBack: () => void;
  onEdit: (baseVersionId: string | null) => void;
  onRepair: (
    error: string,
    versionId: string | null,
    candidate: FamilyApp,
  ) => void;
}) {
  const [versions, setVersions] = useState<AppVersion[]>([]),
    [selected, setSelected] = useState(
      location.hash.split("/")[2] === "version"
        ? location.hash.split("/")[3]
        : "",
    ),
    [preview, setPreview] = useState<{
      policy?: import("./policies/app-policy").Policy | null;
      validation?: Record<string, unknown>;
      source: string;
      context: string;
    } | null>(null),
    [loadState, setLoadState] = useState<
      "loading" | "ready" | "empty" | "error"
    >("loading"),
    [reload, setReload] = useState(0),
    [error, setError] = useState(""),
    [health, setHealth] = useState("checking"),
    [attempt, setAttempt] = useState(0),
    [working, setWorking] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const job = useGeneration();
  useEffect(() => {
    let alive = true;
    diagnostic("app-load-start");
    setPreview(null);
    setLoadState("loading");
    setError("");
    setHealth("checking");
    if (!owner) {
      setPreview(app);
      setLoadState(app.source ? "ready" : "empty");
      return;
    }
    void (async () => {
      await ensureAppVersion(app);
      const list = await listVersions(app.id);
      if (!alive) return;
      setVersions(list);
      const id = selected || app.activeVersionId || list[0]?.id;
      if (id) {
        setSelected(id);
        const v = list.find((v) => v.id === id);
        if (!v)
          throw new Error(
            "The selected version is unavailable. Choose another version or retry loading.",
          );
        const artifact = await readVersion(app.id, v);
        if (alive) {
          setPreview(artifact);
          setLoadState("ready");
          diagnostic("app-load-end");
        }
      } else {
        setPreview(app);
        setLoadState(app.source ? "ready" : "empty");
      }
    })().catch((e) => {
      if (!alive) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoadState("error");
      diagnostic("app-load-failed", {code:diagnosticCode(e)});
    });
    return () => {
      alive = false;
    };
  }, [app.id, app.activeVersionId, app.versionCount, selected, owner, reload]);
  const candidate = owner && !!selected && selected !== app.activeVersionId;
  const act = async (fn: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="app-builder">
      <button className="back-link" onClick={onBack}>
        All apps
      </button>
      <div className="app-builder-heading">
        <h2>{app.title}</h2>
        {owner && (
          <div className="app-builder-actions">
            <button
              className="secondary"
              onClick={() => onEdit(selected || app.activeVersionId || null)}
            >
              Edit app
            </button>
            <button
              className="secondary"
              onClick={() => setConfirmDelete(true)}
            >
              Delete app
            </button>
            <button
              className="primary"
              disabled={
                working || !app.source || candidate || health !== "healthy"
              }
              onClick={() =>
                void act(() =>
                  updateDoc(appRef(app.id), { published: !app.published }),
                )
              }
            >
              {app.published ? "Unshare" : "Share app"}
            </button>
          </div>
        )}
      </div>
      {error && loadState !== "error" && <p role="alert">{error}</p>}
      {confirmDelete && (
        <section
          className="surface app-builder"
          aria-label="Delete app confirmation"
        >
          <h3>Move this app to Trash?</h3>
          <p>You can restore its versions and saved data later.</p>
          <div className="app-builder-actions">
            <button
              className="secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await trashApp(app.id);
                  if (job?.id === app.id) stopGeneration();
                  onBack();
                })
              }
            >
              Move to Trash
            </button>
          </div>
        </section>
      )}
      {owner && versions.length > 0 && (
        <section className="app-context">
          <label>
            Version history
            <select
              value={selected}
              onChange={(e) => {
                if (e.target.value !== selected) {
                  setHealth("checking");
                  setSelected(e.target.value);
                  location.hash =
                    "apps/" + app.id + "/version/" + e.target.value;
                }
              }}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.number}
                  {v.id === app.activeVersionId ? " · Active" : ""}
                </option>
              ))}
            </select>
          </label>
          {candidate && (
            <>
              <p>
                Preview changes use a temporary copy of your data. Saved family
                records will stay in place when you activate this version.
              </p>
              <button
                className="primary"
                disabled={
                  working || loadState !== "ready" || health !== "healthy"
                }
                onClick={() =>
                  void act(async () => {
                    const v = versions.find((v) => v.id === selected)!;
                    await activateVersion(
                      app.id,
                      v,
                      app.activeVersionId ?? null,
                    );
                    location.hash = "apps/" + app.id;
                  })
                }
              >
                Use this version
              </button>
            </>
          )}
        </section>
      )}
      {owner && <AppBuildHistory appId={app.id} />}
      {preview?.source ? (
        <>
          <section className="app-health app-health-inline" aria-live="polite">
            <strong>
              {health === "healthy"
                ? "App started successfully"
                : health === "failed"
                  ? "This app needs a repair"
                  : "Checking app startup…"}
            </strong>
            {health === "failed" && (
              <div className="app-health-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setHealth("checking");
                    setAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </button>
                {owner && (
                  <button
                    className="primary"
                    onClick={() =>
                      onRepair(error, selected || app.activeVersionId || null, {
                        ...app,
                        ...versions.find((v) => v.id === selected),
                        ...preview,
                        id: app.id,
                      })
                    }
                  >
                    Repair app
                  </button>
                )}
              </div>
            )}
          </section>
          {preview.policy && (
            <details>
              <summary>
                App policy ·{" "}
                {preview.validation ? "Policy checks passed" : "Active"}
              </summary>
              <p>
                Family membership is enforced by Firebase. Chore permissions are
                evaluated locally by Kin.
              </p>
              {preview.validation && (
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(preview.validation, null, 2)}
                </pre>
              )}
            </details>
          )}
          <AppPreview
            key={app.id + selected + attempt + candidate}
            appId={app.id}
            policyRequired={!!app.policyRequired || !!app.policy}
            policy={preview.policy ?? (candidate ? null : app.policy)}
            versionId={candidate ? selected : app.activeVersionId}
            source={preview.source}
            context={preview.context}
            isolated={candidate}
            onHealth={setHealth}
            onError={setError}
          />
        </>
      ) : null}
      {loadState === "loading" && <p role="status">Loading saved app…</p>}
      {loadState === "error" && (
        <section className="app-health" role="alert">
          <strong>Could not load this saved version</strong>
          <p>{error}</p>
          <button className="secondary" onClick={() => setReload((n) => n + 1)}>
            Retry loading
          </button>
        </section>
      )}
      {loadState === "empty" && (
        <p>No generated version yet. Continue your draft to build this app.</p>
      )}
    </section>
  );
}
