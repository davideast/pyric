import React, { useLayoutEffect, useState } from "react";
import {
  LightbulbIcon,
  CodeIcon,
  DatabaseIcon,
  WrenchIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  SpinnerGapIcon,
  XIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import {
  resumeGeneration,
  dismissGeneration,
  stopGeneration,
  useGeneration,
  type GenerationEvent,
} from "./generation";
const glyphs = {
  summary: LightbulbIcon,
  context: DatabaseIcon,
  response: CodeIcon,
  tool: WrenchIcon,
  result: CheckCircleIcon,
  error: WarningCircleIcon,
};
function StepIcon({ event }: { event: GenerationEvent }) {
  const Glyph = event.running ? SpinnerGapIcon : glyphs[event.kind];
  return (
    <Glyph
      className={event.running ? "step-icon spinning" : "step-icon"}
      aria-hidden="true"
    />
  );
}
export function GenerationStatus() {
  const job = useGeneration();
  if (!job)
    return (
      <section className="surface app-builder">
        <h2>No build in progress</h2>
        <a href="#apps">Go to apps</a>
      </section>
    );
  return (
    <section className="generation-status surface">
      <a className="back-link" href="#apps">
        All apps
      </a>
      <div className="app-builder-heading">
        <h2>
          {job.state === "running"
            ? "Building "
            : job.state === "ready"
              ? "Ready: "
              : "Build: "}
          {job.title}
        </h2>
        {job.state === "running" && (
          <button className="secondary" onClick={stopGeneration}>
            Stop build
          </button>
        )}
      </div>
      <p>
        {job.state === "running"
          ? "You can keep using Kin. We’ll keep the progress below and let you know when it’s ready. You can reload or return in another tab. Progress is checkpointed to your account."
          : job.state === "ready"
            ? "Your private app is ready to try."
            : "Your prompt and completed stages are saved. Resume this build or start over from your draft."}
      </p>
      {(job.state === "interrupted" || job.state === "awaiting-tab") && (
        <button className="primary" onClick={() => void resumeGeneration()}>
          Resume
        </button>
      )}
      {job.state === "failed" && job.canResume !== false && (
        <button className="primary" onClick={() => void resumeGeneration(true)}>
          Retry stage
        </button>
      )}
      {job.error && <p role="alert">{job.error}</p>}
      <ol className="generation-events">
        {job.events.map((event) => (
          <li key={event.id} data-kind={event.kind}>
            <StepIcon event={event} />
            <details>
              <summary>
                <strong>{event.title}</strong>
                <span>
                  {event.running
                    ? "In progress"
                    : event.kind === "error"
                      ? "Issue"
                      : "Complete"}
                </span>
              </summary>
              {event.kind === "response" ? (
                <pre className="generation-code">
                  {event.detail || "Waiting for the model’s response…"}
                </pre>
              ) : event.kind === "context" ? (
                <pre>
                  {event.detail
                    ? JSON.stringify(JSON.parse(event.detail), null, 2)
                    : "Reading the selected family context…"}
                </pre>
              ) : event.kind === "summary" ||
                event.kind === "result" ||
                event.kind === "error" ? (
                <p className="generation-detail">{event.detail}</p>
              ) : (
                <pre>{event.detail}</pre>
              )}
            </details>
          </li>
        ))}
      </ol>
      {job.state !== "running" && job.state !== "ready" && (
        <a className="primary" href={`#apps/${job.id}/draft`}>
          Start over from draft
        </a>
      )}
      {job.state === "ready" && (
        <a
          className="primary generation-open"
          href={`#apps/${job.id}${job.versionId ? "/version/" + job.versionId : ""}`}
        >
          Open app <ArrowRightIcon />
        </a>
      )}
    </section>
  );
}
function useContentBounds(visible: boolean) {
  const [bounds, setBounds] = useState<{ left: number; width: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!visible) return;
    const content = document.querySelector(".main-content");
    if (!content) return;
    let frame = 0;
    const measure = () => {
      const rect = content.getBoundingClientRect();
      setBounds((previous) =>
        previous?.left === rect.left && previous.width === rect.width
          ? previous
          : { left: rect.left, width: rect.width },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [visible]);
  return bounds;
}
export function GenerationBar({ ownerId }: { ownerId: string }) {
  const job = useGeneration();
  const bounds = useContentBounds(!!job && job.ownerId === ownerId);
  if (!job || job.ownerId !== ownerId) return null;
  const last = job.events.at(-1);
  return (
    <aside
      className="generation-bar"
      style={bounds ?? { visibility: "hidden" }}
      aria-label="App generation progress"
    >
      <a href="#build" className="generation-bar-status">
        {last && <StepIcon event={last} />}
        <span>
          <strong>
            {job.state === "running"
              ? "Building "
              : job.state === "ready"
                ? "Ready: "
                : job.state === "failed"
                  ? "Build failed: "
                  : job.state === "interrupted" || job.state === "awaiting-tab"
                    ? "Build paused: "
                    : "Build stopped: "}
            {job.title}
          </strong>
          <small aria-live="polite">
            {last?.title ?? "Starting your app…"}
          </small>
        </span>
      </a>
      {job.state === "ready" && (
        <a
          className="primary"
          href={`#apps/${job.id}${job.versionId ? "/version/" + job.versionId : ""}`}
        >
          Open app
        </a>
      )}
      {job.state !== "running" && (
        <button
          aria-label="Dismiss build progress"
          className="generation-dismiss"
          onClick={dismissGeneration}
        >
          <XIcon />
        </button>
      )}
    </aside>
  );
}
