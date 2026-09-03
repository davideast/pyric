---
title: "Flutter development setup"
navLabel: "Flutter"
group: "Get started"
section: ""
order: 35
description: "Route cloud_firestore calls from Flutter apps to a local Pyric sandbox bridge during development."
---

# Flutter development setup

Use Pyric with Flutter and FlutterFire without modifying your application data code.

`pyric_firestore` is a platform interface implementation for [`cloud_firestore`](https://pub.dev/packages/cloud_firestore). In debug mode, it routes standard Firestore reads, writes, queries, and listeners across a local WebSocket bridge to your Pyric sandbox. In release builds, normal Firebase Cloud Firestore executes unchanged.

## Add the dependency

Add `pyric_firestore` to your Flutter project's `pubspec.yaml`:

```bash
flutter pub add pyric_firestore
```

## Register the platform interface

In your application entry point (`lib/main.dart`), register `PyricFirestorePlatform` inside a `kDebugMode` guard before initializing UI or accessing Firestore:

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  // In debug builds, redirect Firestore calls to the local Pyric sandbox
  if (kDebugMode) {
    PyricFirestorePlatform.registerWith(
      bridgeClient: PyricBridgeClient(
        uri: Uri.parse('ws://127.0.0.1:5174/__pyric/sandbox'),
      ),
    );
  }

  runApp(const MyApp());
}
```

Every standard `FirebaseFirestore.instance` call (`collection()`, `doc()`, `snapshots()`, transactions, batches) now executes against the local Pyric backend.

## Start the Pyric sandbox bridge

Start the Pyric sandbox with the bridge enabled and listen on your designated port:

```bash
npx pyric sandbox --bridge --port 5174
```

Alternatively, if you run a Vite web application alongside Flutter, enable the bridge in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [
    pyric({
      bridge: true,
    }),
  ],
});
```

The bridge accepts WebSocket connections at `/__pyric/sandbox` on the development server origin.

## Connect from devices and emulators

The connection URI depends on where your Flutter application is running:

| Target Platform | Bridge URI | Setup Command |
| :--- | :--- | :--- |
| **macOS / Windows / Linux desktop** | `ws://127.0.0.1:5174/__pyric/sandbox` | None |
| **iOS Simulator** | `ws://127.0.0.1:5174/__pyric/sandbox` | None |
| **Android Emulator** | `ws://127.0.0.1:5174/__pyric/sandbox` | `adb reverse tcp:5174 tcp:5174` |
| **Physical Device (iOS / Android)** | `ws://<HOST-LAN-IP>:5174/__pyric/sandbox` | Connect to same Wi-Fi / local network |

### Android Emulator setup

Pyric enforces a DNS-rebinding security guard on incoming HTTP and WebSocket requests. When an Android emulator connects through the standard virtual router (`10.0.2.2:5174`), the request header carries `Host: 10.0.2.2:5174`, which the guard rejects.

Run `adb reverse` to forward port 5174 over the emulator's loopback interface:

```bash
adb reverse tcp:5174 tcp:5174
```

With reverse forwarding active, connect to `ws://127.0.0.1:5174/__pyric/sandbox`.

## Supported Firestore capabilities

`pyric_firestore` mirrors FlutterFire's core API surface:

- **Documents & Collections**: `doc()`, `collection()`, `get()`, `set()`, `update()`, `delete()`, and real-time `snapshots()`.
- **Queries**: `where()`, `whereFilter()` (`Filter.and`, `Filter.or`), `orderBy()`, `limit()`, `limitToLast()`, and cursor pagination (`startAt`, `startAfter`, `endAt`, `endBefore`).
- **Aggregations**: `count()`, `aggregate()`.
- **Field Values**: `FieldValue.serverTimestamp()`, `FieldValue.increment()`, `FieldValue.arrayUnion()`, `FieldValue.arrayRemove()`, and `FieldValue.delete()`.
- **Batched Writes**: Atomic `FirebaseFirestore.instance.batch()` commits.
- **Transactions**: Interactive `FirebaseFirestore.instance.runTransaction()` reads and writes.

Check the [Flutter Firestore conformance scorecard](/docs/firestore-flutter-compat/) for detailed behavioral coverage and parity status.
