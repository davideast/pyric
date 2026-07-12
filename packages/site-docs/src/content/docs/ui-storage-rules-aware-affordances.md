---
title: "Rules-aware affordances"
group: "@pyric/ui"
section: "Storage"
order: 23022
---
# Rules-aware affordances

The M7 differentiator: the storage UI knows what the rules will say
**before the click**. One hook — [`useStorageRulesGate`](../ui-storage-usestoragerulesgate/)
— evaluates the current identity against paths with the same evaluator the
sandbox enforces with; the components annotate themselves from its
verdicts. No emulator-UI equivalent exists.

## The wiring

```tsx
const gate = useStorageRulesGate(storage);          // sandbox: zero config
const pathVerdict = gate.verdictFor(nav.path);
```

| Component | Verdict consumed | Affordance |
|---|---|---|
| `<ObjectBrowser gate={gate}>` | `read` per row path | Read-denied rows stamped `data-pyric-denied` (+ the evaluator trace on `data-pyric-denied-reason`). Rows stay **clickable** — navigating into a denied folder surfaces the real `storage/unauthorized` through the existing error UI; the stamp is the early warning. |
| `<UploadDropzone disabled disabledReason>` | `upload` for the destination path | Disabled with the reason stamped on `data-disabled-reason` + `aria-disabled`. Pass `writeResource: { size, contentType }` to the gate when gating a concrete file so size-capped rules evaluate truthfully. |
| `<DeleteSelectionWithConfirm gate={gate}>` | `delete` per selected entry | Trigger disables when ANY entry denies — reason on `data-pyric-denied-reason` + `title` (and `renderTrigger` receives `deniedReason`). |

`delete` and `upload` are derived from `write` — the `pyric/storage`
rules subset has exactly the two top-level verbs (`read` | `write`), and
Firebase Storage's `write` governs create, overwrite, and delete. When the
granular verbs (get/list/create/update/delete) land in the parser, the
verdict shape already has the fields.

## Advisory on prod — the caveat

- **Sandbox: truthful.** The gate reads the ruleset deployed on the handle
  (`getStorageSandbox(ctx, { rules })`) and the context's identity, and
  runs the SAME evaluator that throws `storage/unauthorized`. A denied
  verdict *is* what enforcement will do.
- **Prod: advisory.** Production rules and token claims live server-side;
  you supply a rules mirror + identity to the gate, and both can drift
  from reality. **The server is authoritative** — use prod verdicts to
  improve affordances, never as a security boundary. The gate flags this:
  `advisory: true` on prod handles.

## Fails open, by design

While the gate is loading (sandbox rules resolve async), after a rules
parse error, or when no rules source is reachable, every verdict allows.
A rules-aware affordance must never *grant* anything — enforcement stays
with the sandbox throw / the server — so the safe failure mode is "no
warning", not "everything disabled".

## What's NOT here (yet)

The other half of M7 — a storage **traffic panel** mirroring
`@pyric/ui/traffic`'s request/denial inspection — is blocked: the storage
sandbox enforces synchronously and emits no request events. The exact
event-stream API `pyric/storage` should expose is specified in
the design rationale; the panel
ships when that stream exists.
