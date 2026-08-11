# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Firebase developers and AI coding agents (Claude Code, Antigravity CLI, OpenCode, Codex) building web applications locally in Vite, Node, or CLI environments without relying on live cloud Firebase projects or risking production data and billing.

## Product Purpose

Pyric provides a local-first Firebase development framework. It injects a development-only resolution layer into Firebase applications, routing `firebase/*` imports to a browser-local backend (SharedWorker + IndexedDB) during development while keeping production builds pointing to official Firebase services unchanged. Its primary goal is to shorten time-to-first-win, provide instant local feedback, and give AI coding agents a safe local sandbox to inspect and iterate on data and security rules.

## Positioning

Resolution-time module swapping during local development (`vite dev` / `pyric dev`) backed by a SharedWorker & IndexedDB local engine. Unlike traditional emulators or heavy cloud dependencies, Pyric requires zero code branching in application source code—the exact same SDK imports ship to production Firebase.

## Operating Context

- **Development Environments:** Vite dev server, Node 22.15+, Bun workspace monorepo.
- **Integrated Surfaces:** Pyric Studio (`/__pyric/ui/`), Pyric CLI (`npx pyric`), Pyric MCP bridge (`bridge: true`) for agent interaction.
- **Key Workflows:** Quick scaffolding (`npm create pyric`), local sandbox execution, rules inspection in Pyric Studio, and rule replay/verification (`npx pyric verify`).

## Capabilities and Constraints

- **Capabilities:** Browser-local Firebase SDK emulation (Firestore, Auth, Realtime Database, Storage, Messaging), Security Rules evaluation & audit logging, Pyric Studio inspector UI, MCP server bridge for AI agents, rules verification engine (`pyric verify`), and feature support queries (`npx pyric can-i-use`).
- **Constraints:** ESM-only, Node >= 22.15 required. Alpha stage (`0.1.0-alpha.8`). Local backend is development-only; Pyric has no production deployment path.

## Brand Commitments

- **Name:** Pyric (`pyric`, `@pyric/cli`, `pyric-monorepo`).
- **Website & Brand Assets:** `pyric.dev`, `https://pyric.dev/pyric-logo.svg`.
- **Core Tagline:** "A local first Firebase development framework built for Agents".

## Evidence on Hand

- `README.md` — Core feature overview, quickstart guides, and agent installation instructions.
- `PRIORITIES.md` — Repository strategic focus (Top of Funnel, Simplification, Trust, Build Velocity, Tech Debt).
- `packages/site-docs` — Official documentation site content.
- `packages/conformance` — Canonical compatibility registry and conformance evidence.

## Product Principles

- **Zero Source Branching:** App code uses canonical `firebase/*` imports; development vs production distinction exists purely in dev-server module resolution.
- **Top of Funnel Simplicity:** The getting-started experience must be immediate and effortless without overwhelming users with internal complexity.
- **Progressive Disclosure:** Reveal advanced capabilities (verification, MCP bridge, seed scenarios, custom persistence) on demand as the developer reaches for them.
- **Agent Sandbox First:** Provide AI agents with safe, inspectable, local-first access to Firebase primitives without risking production credentials or cloud state.
- **Honest Conformance & Gaps:** Explicitly report supported features and documented divergences rather than hiding gaps.

## Accessibility & Inclusion

Ensure Pyric Studio UI (`packages/studio`) and documentation (`packages/site-docs`) adhere to clean visual hierarchy, keyboard navigation, and high-contrast readability standards.
