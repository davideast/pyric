# Pyric In-Page Sandbox: Full-Stack Task Application

A standalone, offline-capable single-file HTML application demonstrating Pyric's zero-diff SDK mirrors and real-time security rules verification without requiring a CLI, Vite dev server, or external database backend.

## Overview

This example illustrates how to build high-fidelity interactive browser prototypes and AI agent workflows using Pyric's in-page sandbox bundle. The single `index.html` artifact executes completely inside browser runtime memory and can be opened directly in any modern desktop or mobile browser, or rendered within an `about:srcdoc` iframe in AI IDE previews.

## Features & Architecture

### 1. Zero-Diff Production Application View
The main task management interface communicates strictly through standard Firebase Web SDK contract wrappers (`doc`, `setDoc`, `onSnapshot`, `uploadBytes`, `signInWithEmailAndPassword`, `getToken`). The primary UI contains zero mock drivers, simulation selectors, or test fixtures, ensuring the application source is zero-diff swappable with a production Firebase backend.

### 2. Full-Screen Developer Console Modal
Clicking the **⚡ Inspect Pyric Sandbox** button in the footer opens an authoritative full-screen simulation workspace. This console isolates all mock drivers and inspection tools from the main application view:

- **🗄️ Firestore & Storage Inspector:** Live document counting, collection summaries, active security rules viewing, and a persistent record of security rule denials with line numbers and evaluator expressions.
- **📡 Realtime Database (RTDB) Controls:** Interactive controls to toggle live user presence (`/presence/$uid`), execute atomic multi-path fan-out writes, and trigger intentional `.validate` rule mismatches. Includes live activity stream logging.
- **🤖 AI Logic Scripting & Task Assistant:** Test bench for generating structured onboarding tasks via `pyric/ai`. Demonstrates pre-write in-memory schema validation before saving to Firestore, complete with switchable test fixtures (Valid JSON, Malformed Schema, and 429 Quota Exceeded).
- **📬 Cloud Messaging (FCM) Simulator:** Push notification testing drivers powered by `messagingSandbox.deliver(...)`. Simulates foreground notifications and silent data payloads gated by token registration state.

### 3. Modern Layout Architecture
Designed with classic **shadcn/ui** visual aesthetics and constructed using modern Flexbox & CSS Grid + `gap` spacing architecture, eliminating legacy margin collapsing and selector specificity clashes during dynamic UI state transitions.

## Quick Start

No installations, build steps, or local dev servers are required:

1. Double-click `index.html` to open it directly in your browser.
2. Sign in with pre-seeded demo accounts (**Alice** or **Bob**) or test Pluggable OAuth / Guest sessions.
3. Add tasks, upload simulated image attachments, and toggle completed states.
4. Click **⚡ Inspect Pyric Sandbox** to explore live database mutations, simulated push alerts, and security rule evaluation logs.
