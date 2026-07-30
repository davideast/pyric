# Pyric In-Page Sandbox: Reactive Task Workspace

A self-contained TypeScript + Vite reference application demonstrating Pyric's zero-diff Web SDK mirrors and in-page simulation drivers with disciplined codebase architecture.

## Architectural Seams & Module Depth

This application adheres strictly to modular design principles, establishing clear architectural **seams** that decouple reactive user interfaces from domain state and simulation drivers. Instead of scattering shallow script logic across HTML markup, the codebase concentrates domain behaviors into **deep modules** with narrow **interfaces**:

```
┌─────────────────────────────────────────────────────────────┐
│                       index.html & UI                       │
│    (Declarative layout, DOM events, and Toast rendering)    │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
       [Domain Seam]                   [Simulation Seam]
               │                               │
               ▼                               ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│ TaskApplicationService       │ │ SandboxSimulationDriver    │
│ (src/services/firebase-ser...)│ │ (src/sandbox/sandbox-driver)│
│                              │ │                            │
│ • Deep business adapter      │ │ • Administrative driver    │
│ • Zero UI leakage            │ │ • Rules deployment & tests │
│ • High domain locality       │ │ • Simulated push payloads  │
└──────────────────────────────┘ └────────────────────────────┘
```

### 1. Domain Adapter Module (`src/services/firebase-service.ts`)
The `TaskApplicationService` acts as the definitive application domain **adapter**. It consolidates standard Firebase Web SDK interactions across Authentication, Firestore, Cloud Storage, Realtime Database, AI Logic, and Cloud Messaging into a deep domain **interface**. By encapsulating query formation and serialization within this **module**, the UI layer attains high **locality** and maintains zero structural coupling to low-level database schemas.

### 2. Simulation Driver Module (`src/sandbox/sandbox-driver.ts`)
The `SandboxSimulationDriver` governs the administrative lifecycle of the in-page sandbox. It encapsulates declarative security rules deployment (`setRules`), demo profile provisioning (`authSandbox.createUser`), Realtime Database atomic fan-out testing, and synthetic push message delivery (`messagingSandbox.deliver`). Isolating these mechanics creates a clear **seam** between production-swappable application logic and offline verification harnesses.

### 3. Reactive UI Consumer (`src/main.ts` & `index.html`)
The user interface operates strictly as a consumer of domain and simulation interfaces. Constructed with modern Flexbox and CSS Grid + `gap` architecture to eliminate legacy margin collapsing and selector specificity clashes, the UI presents a zero-diff production workspace view alongside an interactive Developer Console dialog.

## Multi-Service Verification Surface

- **🗄️ Firestore & Storage Rules:** Evaluates document mutations against declarative policies in real time, surfacing line-numbered denial contexts and evaluator expressions directly inside the UI debug banner and console inspector.
- **📡 Realtime Database (RTDB):** Demonstrates live user presence heartbeats (`/presence/$uid`), atomic multi-path fan-out transactions, and intentional `.validate` rule failure scenarios.
- **🤖 AI Logic Scripting:** Generates structured onboarding milestones using `pyric/ai` with in-memory schema validation prior to Firestore insertion, complete with switchable scenario test fixtures (Valid JSON, Malformed Schema, and 429 Quota Exceeded).
- **📬 Cloud Messaging (FCM):** Delivers simulated foreground toast alerts and silent data refresh payloads via authoritative testing drivers without requiring network connections or background service workers.

## Quick Start

1. Install dependencies across the monorepo workspace:
   ```bash
   pnpm install # or npm install
   ```
2. Launch the local development preview:
   ```bash
   pnpm run dev
   ```
3. Open the displayed local server URL to interact with the offline in-page sandbox.
