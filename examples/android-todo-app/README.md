# Pyric Android Todo Sample App

A modern Android sample application built with Jetpack Compose and Material 3, demonstrating real-time synchronization with a local [Pyric](https://github.com/davideast/pyric) sandbox via the pure-Kotlin Firestore SDK (`kt-client`).

## Architecture

The app follows standard Android Unidirectional Data Flow (UDF / MVVM):
- **UI Layer (`dev.pyric.example.todo.ui`)**: Jetpack Compose Material 3 components (`TodoScreen`, `TodoList`, `TodoItemRow`, `TodoFilterRow`, `ConnectionBadge`, `AddTodoDialog`).
- **ViewModel Layer (`dev.pyric.example.todo.ui.viewmodel`)**: `TodoViewModel` exposing an immutable `StateFlow<TodoUiState>` bound to the lifecycle via `SharingStarted.WhileSubscribed(5000)`.
- **Domain & Data Layer (`dev.pyric.example.todo.data`)**: `TodoRepository` interface and `FirestoreTodoRepository` leveraging Pyric's pure-Kotlin Firestore SDK (`dev.pyric:kt-client`).
- **Network Layer (`dev.pyric.example.todo.network`)**: `PyricBridgeHealth` diagnostics monitoring loopback health.

## Prerequisites

1. **Java & Android Toolchains**:
   - Temurin OpenJDK 21 LTS (`/Users/deast/.jdk/jdk-21.0.12.1+1/Contents/Home`)
   - Android SDK API 35 (`/Users/deast/Library/Android/sdk`)
2. **Pyric Local Sandbox**:
   Start the local sandbox server from the monorepo root:
   ```bash
   bun run serve
   ```
   Open `http://localhost:5174` in your browser to host the active sandbox tab.

## Critical Emulator Connectivity: ADB Reverse

Android applications running inside the Android Emulator connect to host loopback via `adb reverse`:
```bash
adb reverse tcp:5174 tcp:5174
```

### Why ADB Reverse is Required (DNS-Rebinding Guard)

Pyric implements a strict DNS-rebinding security guard (`isAllowedHost` in `@pyric/cli`). Requests carrying hostnames other than `localhost`, `127.0.0.1`, `::1`, or the bound host are rejected with HTTP `403 Forbidden` and WebSocket socket closure.

Connecting to the default Android emulator virtual router IP `10.0.2.2:5174` fails the guard because the `Host` header is `10.0.2.2:5174`. By executing `adb reverse tcp:5174 tcp:5174`, the emulator loopback `127.0.0.1:5174` is forwarded over ADB to the host machine's `127.0.0.1:5174`, preserving `Host: 127.0.0.1:5174` and passing Pyric's DNS-rebinding guard cleanly.

Network security configuration is defined in `app/src/main/res/xml/network_security_config.xml` to permit cleartext WebSocket traffic (`ws://127.0.0.1:5174/__pyric/sandbox`).

## Building the Project

Run Gradle tasks from the monorepo root or within this directory:

### Run Unit Tests
```bash
export JAVA_HOME="/Users/deast/.jdk/jdk-21.0.12.1+1/Contents/Home"
export ANDROID_HOME="/Users/deast/Library/Android/sdk"

./gradlew test
```

### Assemble Debug APK
```bash
export JAVA_HOME="/Users/deast/.jdk/jdk-21.0.12.1+1/Contents/Home"
export ANDROID_HOME="/Users/deast/Library/Android/sdk"

./gradlew assembleDebug
```
The APK is generated at:
`app/build/outputs/apk/debug/app-debug.apk`

## Installing and Running on Emulator

With your Android emulator running (e.g. `emulator-5554`):

1. Establish port reverse:
   ```bash
   adb -s emulator-5554 reverse tcp:5174 tcp:5174
   ```

2. Install debug APK:
   ```bash
   adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
   ```

3. Launch application:
   ```bash
   adb -s emulator-5554 shell am start -n dev.pyric.example.todo/dev.pyric.example.todo.ui.MainActivity
   ```

4. Verify live sync:
   - In the app, observe the top bar badge displaying `Synced` (green).
   - Add, toggle, or delete todos in the Android app; verify real-time bidirectional synchronization with the browser tab at `http://localhost:5174`.
