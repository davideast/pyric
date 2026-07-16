# Local-to-Production Workflow

This is the final navigation hierarchy for issue #312. It replaces the earlier package, feature, and rules-wing taxonomies.

Pyric has one job in the learning path: let Firebase application code run against a local sandbox during development, then let the same code resolve to Firebase in production. The navigation follows that lifecycle.

```text
Overview

RUN LOCALLY
  Quickstart
  How the swap works
  Set up an agent
  Test in Node

DEVELOP WITH FIREBASE APIS
  Sign in and manage users
  Store and query data
  Sync realtime data
  Store files
  Receive messages
  Run AI Logic locally
  Run an RTDB function locally
  Which data service?

INSPECT AND CORRECT
  Inspect the sandbox
    Traffic and rule verdicts
    Read a denial
    Seed, snapshot, and replay
    Review agent activity
  Correct Security Rules
    Security Rules
    Simulate and lint
    Rules patterns
    Rules standard library
    RTDB rules in TypeScript
    Rules limits
    Case studies
  Work with an agent
    What an agent can do
    Skills

VERIFY THE BOUNDARY
  Verify a captured session
  Write a rules test suite
  Audit rules and data

SHIP UNCHANGED
  Ship to production
  Set up the Firebase project

CONFORMANCE
  How Pyric knows it works like Firebase
  What's experimental
  Conformance scores
  App, Firestore, Auth, Realtime Database, Storage, Rules,
  Messaging, AI Logic, and Functions with RTDB evidence

REFERENCE
  Generated and package-owned reference, collapsed from the primary path
```

## Why products sit under development

Auth, Firestore, Realtime Database, Storage, Messaging, AI Logic, and Functions are not separate Pyric workflows. They are the Firebase APIs used while developing. Their guide pages appear when application code is being written. Product-specific local behavior remains linked from those pages and searchable in reference.

## Why inspection and correction share a phase

Development moves between writing code, observing an operation, and correcting data or rules. Those actions form one loop. Studio, denial inspection, state controls, agent activity, and Security Rules therefore live together instead of becoming separate product or tool sections.

## Why verification is not conformance

Verification asks whether the application crosses the local-to-production boundary safely. It uses captured sessions, rules tests, and audits against the application's own behavior.

Conformance asks whether Pyric itself matches Firebase. It is a separate evidence system with its own method, scores, limitations, and product matrices. A reader can complete the workflow without studying it, then inspect the evidence before deciding how much to trust the mirror.

## Route policy

The hierarchy changes navigation ownership, not URLs. Existing authored and package-documentation routes remain stable. Package reference, generated TypeDoc pages, and detailed conformance matrices stay built, searchable, and available to agents without occupying the primary learning path.
