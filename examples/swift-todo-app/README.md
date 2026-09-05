# Pyric Swift Todo App (SwiftUI on iOS Simulator)

A reactive SwiftUI demo application showcasing the Pure-Swift Firestore Client (`packages/swift-client`) communicating with Pyric's local WebSocket bridge (`ws://127.0.0.1:5174/__pyric/sandbox`).

The app runs natively on the iOS Simulator (`iPhone 17`), demonstrating real-time snapshot streams (`collection("todos").snapshots`), document creation with server timestamps (`addDocument`), state toggling (`updateData`), and swipe-to-delete (`delete`).

---

## Architecture

- **UI Framework**: SwiftUI (NavigationStack, List, ObservedObject)
- **Concurrency**: Swift 6 Strict Concurrency with `@MainActor` UI isolation
- **Client**: `PyricFirestore` linked via local Swift Package Manager dependency
- **Transport**: Native `URLSessionWebSocketTask` connecting directly to host loopback `127.0.0.1:5174`
- **Network Permissions**: Configured with `NSAppTransportSecurity` local networking exceptions in `Info.plist`

---

## Prerequisites

1. **macOS** with Xcode command-line tools installed.
2. **Booted iOS Simulator**:
   ```bash
   xcrun simctl list devices | grep -E "iPhone 17 .*\(Booted\)"
   ```
   If needed, boot `iPhone 17`:
   ```bash
   xcrun simctl boot "iPhone 17"
   ```
3. **Pyric Bridge** running on port 5174:
   ```bash
   curl -s http://127.0.0.1:5174/__pyric/health
   ```

---

## Quick Start (Makefile)

The included `Makefile` automates compilation, bundle packaging, simulator deployment, and execution:

```bash
# Build binary and assemble SwiftTodoApp.app bundle
make all

# Install and launch on the booted simulator
make run

# Capture a screenshot to build/screenshot.png and screenshots/
make screenshot

# Stream application logs
make logs

# Terminate the application
make stop

# Clean build artifacts
make clean
```

---

## Manual Build & Run Instructions

### 1. Compile for iOS Simulator

```bash
SDK_PATH=$(xcrun --show-sdk-path --sdk iphonesimulator)

swift build \
  --package-path . \
  --triple arm64-apple-ios18.0-simulator \
  --sdk "$SDK_PATH"
```

### 2. Assemble `.app` Bundle

```bash
mkdir -p build/SwiftTodoApp.app
cp .build/arm64-apple-ios-simulator/debug/SwiftTodoApp build/SwiftTodoApp.app/SwiftTodoApp
cp Info.plist build/SwiftTodoApp.app/Info.plist
echo -n "APPL????" > build/SwiftTodoApp.app/PkgInfo
```

### 3. Deploy and Launch

```bash
xcrun simctl install booted build/SwiftTodoApp.app
xcrun simctl launch booted com.pyric.swifttodoapp
```

### 4. Capture Screenshot

```bash
xcrun simctl io booted screenshot build/screenshot.png
```

---

## Testing Real-Time Synchronization

1. Launch `SwiftTodoApp` on the booted iOS Simulator.
2. Open the Pyric Web Sandbox in your browser (e.g. `http://127.0.0.1:5174`).
3. Add or toggle todos in the iOS Simulator:
   - Changes are encoded as `worker-op` RPC calls across `URLSessionWebSocketTask`.
   - The Pyric bridge relays changes to the browser sandbox.
4. Changes made in the web sandbox or other peers stream back via `worker-snap` frames, instantly updating the SwiftUI `List`.
