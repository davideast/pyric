import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

const host = globalThis as typeof globalThis & {
  __inbrowserPreviewScope__: Record<string, unknown>;
  __inbrowserCompiledPreview__: {
    default: React.ComponentType<{ family: unknown }>;
  };
  __kinFamily: unknown;
  __kinToken: string;
  mountKin: () => void;
};
type RecordData = { id: string; [key: string]: unknown };
const pending = new Map<
  string,
  { resolve: () => void; reject: (e: Error) => void }
>();
const subscribers = new Set<(records: RecordData[]) => void>();
const failures = new Set<(error: string) => void>();
let records: RecordData[] = [];
let ready = false;
function request(
  op: string,
  id: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    parent.postMessage(
      { kind: "kin-data", token: host.__kinToken, op, id, data, requestId },
      "*",
    );
  });
}
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.token !== host.__kinToken) return;
  if (event.data.kind === "kin-records") {
    records = event.data.records;
    ready = true;
    subscribers.forEach((fn) => fn(records));
  } else if (event.data.kind === "kin-data-error") {
    failures.forEach((fn) => fn(event.data.error));
  } else if (event.data.kind === "kin-data-result") {
    const call = pending.get(event.data.requestId);
    pending.delete(event.data.requestId);
    if (event.data.error)
      call?.reject(
        Object.assign(new Error(event.data.error), {
          code: event.data.code,
          diagnostics: event.data.diagnostics,
        }),
      );
    else call?.resolve();
  }
});
type AppIdentity = {
  uid: string;
  name: string;
  avatarUrl: string;
  familyId: string;
  role: "parent" | "kid";
};
let identity: AppIdentity | null = null;
let identityLoading = true;
const identitySubscribers = new Set<() => void>();
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.token !== host.__kinToken) return;
  if (event.data.kind === "kin-identity") {
    identity = event.data.user;
    identityLoading = false;
    identitySubscribers.forEach((fn) => fn());
  }
  if (event.data.kind === "kin-session-ended") {
    identity = null;
    identityLoading = true;
    records = [];
    subscribers.forEach((fn) => fn([]));
    identitySubscribers.forEach((fn) => fn());
    pending.forEach((call) =>
      call.reject(new Error("Your session changed. Reopen the app.")),
    );
    pending.clear();
  }
});
function useAppIdentity() {
  const [, update] = React.useState(0);
  React.useEffect(() => {
    const fn = () => update((n) => n + 1);
    identitySubscribers.add(fn);
    parent.postMessage(
      { kind: "kin-identity-request", token: host.__kinToken },
      "*",
    );
    return () => {
      identitySubscribers.delete(fn);
    };
  }, []);
  return { user: identity, loading: identityLoading };
}
function useAppData() {
  const [items, setItems] = React.useState(records),
    [error, setError] = React.useState(""),
    [loading, setLoading] = React.useState(!ready);
  React.useEffect(() => {
    const receive = (data: RecordData[]) => {
      setItems(data);
      setLoading(false);
    };
    subscribers.add(receive);
    failures.add(setError);
    parent.postMessage(
      { kind: "kin-data", token: host.__kinToken, op: "subscribe" },
      "*",
    );
    return () => {
      subscribers.delete(receive);
      failures.delete(setError);
    };
  }, []);
  return {
    records: items,
    error,
    loading,
    setRecord: (id: string, data: Record<string, unknown>) =>
      request("set", id, data),
    deleteRecord: (id: string) => request("delete", id),
  };
}
host.__inbrowserPreviewScope__ = {
  react: React,
  "react/jsx-runtime": jsx,
  "react/jsx-dev-runtime": jsx,
  "@kin/app": { useAppData, useAppIdentity },
};
const report = (error: unknown) =>
  parent.postMessage(
    {
      kind: "kin-preview-error",
      token: host.__kinToken,
      message: String(error).slice(0, 1000),
    },
    "*",
  );
window.addEventListener("error", (event) => report(event.message));
window.addEventListener("unhandledrejection", (event) => report(event.reason));
class Boundary extends React.Component<
  React.PropsWithChildren,
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error) {
    report(error.message);
  }
  render() {
    return this.state.error ? (
      <p role="alert">This app could not run. Ask the parent to revise it.</p>
    ) : (
      this.props.children
    );
  }
}
function HealthCheck({ children }: React.PropsWithChildren) {
  React.useEffect(() => {
    const timer = setTimeout(
      () =>
        parent.postMessage(
          { kind: "kin-preview-ready", token: host.__kinToken },
          "*",
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, []);
  return <>{children}</>;
}
host.mountKin = () => {
  const App = host.__inbrowserCompiledPreview__?.default;
  if (!App) throw new Error("No default React component was generated.");
  createRoot(document.getElementById("root")!).render(
    <Boundary>
      <HealthCheck>
        <App family={host.__kinFamily} />
      </HealthCheck>
    </Boundary>,
  );
};
