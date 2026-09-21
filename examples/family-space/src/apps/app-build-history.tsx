import { openBuild } from "./generation/generation";
import React, { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db, base } from "../data";
import type { GenerationEvent } from "./generation/generation-types";
export function AppBuildHistory({ appId }: { appId: string }) {
  const [builds, setBuilds] = useState<
      Array<{ id: string; state: string; createdAt: number; error?: string }>
    >([]),
    [events, setEvents] = useState<Record<string, GenerationEvent[]>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void getDocs(collection(db, `${base}/apps/${appId}/builds`))
      .then((s) => {
        if (alive)
          setBuilds(
            s.docs
              .map((d) => ({ id: d.id, ...d.data() }) as any)
              .sort((a, b) => b.createdAt - a.createdAt),
          );
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
  }, [appId]);
  return (
    <details className="app-context">
      <summary>Build history</summary>
      {error && <p role="alert">{error}</p>}
      {!builds.length && <p>No generation attempts recorded yet.</p>}
      {builds.map((b) => (
        <details
          key={b.id}
          onToggle={(e) => {
            if (e.currentTarget.open && !events[b.id])
              void getDocs(
                collection(db, `${base}/apps/${appId}/builds/${b.id}/events`),
              )
                .then((s) =>
                  setEvents((old) => ({
                    ...old,
                    [b.id]: s.docs
                      .map((d) => d.data() as GenerationEvent)
                      .sort((a, b) => a.id - b.id),
                  })),
                )
                .catch((e) => setError(String(e)));
          }}
        >
          <summary>
            {new Date(b.createdAt).toLocaleString()} · {b.state}
          </summary>
          {b.error && <p>{b.error}</p>}
          {b.state !== "ready" && (
            <button
              className="secondary"
              onClick={() => void openBuild(appId, b.id)}
            >
              Review recovery
            </button>
          )}
          <ol>
            {events[b.id]?.map((e) => (
              <li key={e.id}>
                <details>
                  <summary>{e.title}</summary>
                  <pre>{e.detail}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ))}
    </details>
  );
}
