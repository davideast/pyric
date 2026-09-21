import { onAuthStateChanged } from "firebase/auth";
import { writePolicyRecord } from "./policy-bridge";
import {
  checkPolicy,
  policyCase,
  PolicyError,
  type Policy,
} from "./app-policy";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import { auth, db, base } from "./data";
import React, { useEffect, useRef, useState } from "react";
import runtime from "virtual:kin-preview-runtime";
import styles from "./styles.css?inline";
import { ErrorNotice } from "./ui";
import { compileFamilyApp } from "./app-compiler";
export { compileFamilyApp } from "./app-compiler";

let fontData: Promise<string> | undefined;
function previewFont() {
  return (fontData ??= fetch("/fonts/GeneralSans-Semibold.woff2").then(
    async (r) => {
      if (!r.ok) throw new Error("Could not load the app heading font.");
      const bytes = new Uint8Array(await r.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return "data:font/woff2;base64," + btoa(binary);
    },
  ));
}
const scriptSafe = (value: string) =>
  value.replace(/<\/script/gi, "<\\/script");
export function AppPreview({
  appId,
  source,
  context,
  onError,
  onHealth,
  isolated = false,
  policy,
  versionId,
  policyRequired = false,
}: {
  policy?: Policy | null;
  versionId?: string | null;
  policyRequired?: boolean;
  isolated?: boolean;
  appId: string;
  source: string;
  context: string;
  onError?: (message: string) => void;
  onHealth?: (state: "checking" | "healthy" | "failed") => void;
}) {
  const [html, setHtml] = useState(""),
    [error, setError] = useState("");
  const [identity, setIdentity] = useState<{
    uid: string;
    name: string;
    avatarUrl: string;
    familyId: string;
    role: "parent" | "kid";
  } | null>(null);
  useEffect(() => {
    let stopMember: (() => void) | undefined;
    const stop = onAuthStateChanged(auth, (user) => {
      stopMember?.();
      setIdentity(null);
      if (user)
        stopMember = onSnapshot(
          doc(db, base + "/members/" + user.uid),
          (snapshot) => {
            const m = snapshot.data();
            setIdentity(
              m
                ? {
                    uid: user.uid,
                    name: m.name,
                    avatarUrl: m.avatar,
                    familyId: base.split("/")[1],
                    role: m.role,
                  }
                : null,
            );
          },
        );
    });
    return () => {
      stop();
      stopMember?.();
    };
  }, []);
  const [policyFailure, setPolicyFailure] = useState<{
    code: string;
    message: string;
    diagnostics: unknown;
  } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!identity) {
      setHtml("");
      return;
    }
    let alive = true;
    let previewRecords: Record<string, unknown>[] = [];
    let initialized = false;
    let stopRecords: (() => void) | undefined;
    const token = crypto.randomUUID();
    setHtml("");
    setError("");
    setPolicyFailure(null);
    onHealth?.("checking");
    let failed = false;
    const fail = (message: string) => {
      if (alive) {
        if (failed) return;
        failed = true;
        onHealth?.("failed");
        setError(message);
        onError?.(message);
      }
    };
    const timeout = setTimeout(
      () =>
        fail(
          "The app did not finish its startup check. Try again or repair it.",
        ),
      15000,
    );
    const send = (data: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage({ ...data, token }, "*");
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.token !== token
      )
        return;
      if (event.data.kind === "kin-identity-request") {
        send({ kind: "kin-identity", user: identity });
        return;
      }
      if (event.data.kind === "kin-preview-ready") {
        clearTimeout(timeout);
        if (!failed) onHealth?.("healthy");
        return;
      }
      if (event.data.kind === "kin-preview-error") {
        fail(event.data.message);
        return;
      }
      if (event.data.kind !== "kin-data") return;
      const { op, id, data, requestId } = event.data;
      if (op === "subscribe") {
        stopRecords?.();
        stopRecords = onSnapshot(
          collection(db, base + "/apps/" + appId + "/records"),
          (snapshot) => {
            if (isolated && initialized) return;
            initialized = true;
            previewRecords = snapshot.docs.map((d) => ({
              ...d.data(),
              id: d.id,
            }));
            send({ kind: "kin-records", records: previewRecords });
          },
          (e) => send({ kind: "kin-data-error", error: e.message }),
        );
        return;
      }
      if (
        !["set", "delete"].includes(op) ||
        typeof id !== "string" ||
        !/^[-a-zA-Z0-9_]{1,100}$/.test(id)
      ) {
        send({
          kind: "kin-data-result",
          requestId,
          error: "Invalid record ID.",
        });
        return;
      }
      if (
        op === "set" &&
        (!data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          JSON.stringify(data).length > 20000)
      ) {
        send({
          kind: "kin-data-result",
          requestId,
          error: "Record must be an object under 20 KB.",
        });
        return;
      }
      if (isolated && policyRequired && !policy) {
        send({
          kind: "kin-data-result",
          requestId,
          error: "This version has no app policy.",
          code: "invalid-policy",
        });
        return;
      }
      if (isolated && policy) {
        void (async () => {
          const { getDocs } = await import("firebase/firestore");
          const members = Object.fromEntries(
            (await getDocs(collection(db, base + "/members"))).docs.map((d) => [
              d.id,
              d.data(),
            ]),
          );
          const existing = previewRecords.find((r) => r.id === id);
          const before = existing
            ? Object.fromEntries(
                Object.entries(existing).filter(([k]) => k !== "id"),
              )
            : undefined;
          const proposed =
            policy.format === 1 && before && members[identity.uid]?.role === "parent" && op === "set"
              ? { ...before, ...data }
              : data;
          checkPolicy(
            policy,
            policyCase(
              op === "delete" ? "delete" : before ? "update" : "create",
              identity.uid,
              members,
              before,
              proposed,
              "ALLOW",
              identity.familyId,
              appId,
              id,
            ),
          );
          if (!alive || auth.currentUser?.uid !== identity.uid)
            throw new PolicyError("session", "Your session changed.");
          previewRecords = previewRecords.filter((r) => r.id !== id);
          if (op === "set") previewRecords.push({ ...proposed, id });
          send({ kind: "kin-records", records: previewRecords });
          send({ kind: "kin-data-result", requestId });
        })().catch((e) => {
          setPolicyFailure({
            code: e.code ?? "backend",
            message: e.message,
            diagnostics: e.diagnostics ?? null,
          });
          send({
            kind: "kin-data-result",
            requestId,
            error: e.message,
            code: e.code,
            diagnostics: e.diagnostics,
          });
        });
        return;
      }
      if (isolated) {
        previewRecords = previewRecords.filter((r) => r.id !== id);
        if (op === "set") previewRecords.push({ ...data, id });
        send({ kind: "kin-records", records: previewRecords });
        send({ kind: "kin-data-result", requestId });
        return;
      }
      {
        void writePolicyRecord(
          db,
          base,
          appId,
          versionId,
          identity.uid,
          () => alive && auth.currentUser?.uid === identity.uid,
          op,
          id,
          data,
        ).then(
          () => send({ kind: "kin-data-result", requestId }),
          (e) => {
            setPolicyFailure({
              code: e.code ?? "backend",
              message: e.message,
              diagnostics: e.diagnostics ?? null,
            });
            send({
              kind: "kin-data-result",
              requestId,
              error: e.message,
              code: e.code,
              diagnostics: e.diagnostics,
            });
          },
        );
        return;
      }
    };
    window.addEventListener("message", receive);
    void Promise.all([compileFamilyApp(source), previewFont()])
      .then(([code, font]) => {
        if (!alive) return;
        const origin = location.origin;
        const css = styles.replace(
          'url("/fonts/GeneralSans-Semibold.woff2")',
          `url("${font}")`,
        );
        const csp = `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';`;
        setHtml(
          `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${css}</style></head><body><div id="root"></div><script nonce="${token}">globalThis.__kinToken=${JSON.stringify(token)};globalThis.__kinFamily=${scriptSafe(context)};\n${scriptSafe(runtime)}\n${scriptSafe(code)}\nglobalThis.mountKin();<\/script></body></html>`,
        );
      })
      .catch((e) => fail(e.message));
    return () => {
      send({ kind: "kin-session-ended" });
      alive = false;
      clearTimeout(timeout);
      stopRecords?.();
      window.removeEventListener("message", receive);
    };
  }, [
    appId,
    source,
    context,
    isolated,
    identity,
    policy,
    versionId,
    policyRequired,
  ]);
  return (
    <>
      {!onHealth && <ErrorNotice message={error} />}
      {policyFailure && (
        <details>
          <summary>
            {policyFailure.message} · {policyFailure.code}
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(policyFailure.diagnostics, null, 2)}
          </pre>
        </details>
      )}
      {html ? (
        <iframe
          hidden={!!error && !!onHealth}
          ref={frame}
          title="Family app preview"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={html}
          className="family-app-preview"
        />
      ) : (
        !error && <p role="status">Preparing your app…</p>
      )}
    </>
  );
}
