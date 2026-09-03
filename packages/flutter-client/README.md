# pyric_firestore

Route standard FlutterFire `cloud_firestore` calls to a local Pyric sandbox in debug mode without altering application code.

## Usage

In debug mode, register `PyricFirestorePlatform` before accessing Firestore:

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: const FirebaseOptions(
      apiKey: 'dummy-api-key',
      appId: '1:1234567890:web:pyric-todo',
      messagingSenderId: '1234567890',
      projectId: 'pyric-demo',
    ),
  );

  // In debug mode, standard cloud_firestore calls route to Pyric's local sandbox bridge.
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

All existing `cloud_firestore` code works unchanged:

```dart
final todos = FirebaseFirestore.instance.collection('todos');

// Writes support FieldValue sentinels
await todos.doc('task-1').set({
  'title': 'Test with Pyric',
  'completed': false,
  'createdAt': FieldValue.serverTimestamp(),
});

// Queries support filters, ordering, limits, and real-time listeners
todos
    .where('completed', isEqualTo: false)
    .orderBy('createdAt', descending: true)
    .limit(10)
    .snapshots()
    .listen((snapshot) {
      for (final change in snapshot.docChanges) {
        print('${change.type}: ${change.doc.data()}');
      }
    });
```

## Getting Started

### 1. Add dependency

```bash
flutter pub add pyric_firestore
```

### 2. Start the Pyric Sandbox Bridge

In your repository or project directory, start the Pyric sandbox with the bridge enabled:

```bash
npx pyric sandbox --bridge --port 5174
```

### 3. Connect from Device or Emulator

The connection URI depends on the target platform:

| Environment | Bridge URI | Setup Command |
| :--- | :--- | :--- |
| **macOS / Windows / Linux** | `ws://127.0.0.1:5174/__pyric/sandbox` | None |
| **iOS Simulator** | `ws://127.0.0.1:5174/__pyric/sandbox` | None |
| **Android Emulator** | `ws://127.0.0.1:5174/__pyric/sandbox` | `adb reverse tcp:5174 tcp:5174` |
| **Physical Device** | `ws://<HOST-IP>:5174/__pyric/sandbox` | None (same Wi-Fi / LAN) |

> **Note for Android Emulators**: Pyric enforces a DNS-rebinding guard on incoming requests. Routing via `10.0.2.2:5174` sets `Host: 10.0.2.2:5174`, which the guard rejects. Running `adb reverse tcp:5174 tcp:5174` forwards `127.0.0.1:5174` cleanly through the loopback interface.

## Supported Capabilities

- **Document Reference**: `get()`, `set()`, `update()`, `delete()`, `snapshots()`
- **Collection Reference**: `add()`, `doc()`, `parent`, `path`
- **Queries**: `where()`, `whereFilter()` (`Filter.and`, `Filter.or`), `orderBy()`, `limit()`, `limitToLast()`, `startAt()`, `startAfter()`, `endAt()`, `endBefore()`, `count()`, `aggregate()`, `snapshots()`
- **Field Values**: `FieldValue.serverTimestamp()`, `FieldValue.increment()`, `FieldValue.arrayUnion()`, `FieldValue.arrayRemove()`, `FieldValue.delete()`
- **Atomic Batches**: `FirebaseFirestore.instance.batch()` with batched `set`, `update`, `delete`, and `commit()`
- **Transactions**: Interactive runTransaction with platform read/write hooks

## License

Apache 2.0. See [LICENSE](LICENSE) for details.
