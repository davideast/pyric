import Foundation
import Testing
@testable import PyricFirestore

// Shared by the call-order tests (D1, D2 in ADR-0019). The fake bridge lives
// in BridgeReconnectTests.swift.

/// Holds a client's admission order shut for a test. The gate is a turn taken
/// and not yet presented: every operation that takes a later turn waits behind
/// it, while an operation that takes no turn is admitted at once.
///
/// A test takes the gate, makes an earlier call that takes a turn, then the
/// call under test. With the gate shut, the call under test either takes a
/// turn behind the earlier one or, if it takes none, reaches the bridge first.
/// `open` waits for whichever happens, so the test needs no sleep either way.
final class CallOrderGate: @unchecked Sendable {
    private let client: PyricBridgeClient
    private let gate: OperationTurn
    private let lock = NSLock()
    private var probes: [OperationTurn] = []

    init(_ client: PyricBridgeClient) {
        self.client = client
        gate = client.takeTurn()
    }

    /// Turns taken by calls since the gate. Finding out takes a probe turn,
    /// which is not counted and is presented when the gate opens.
    func callTurnsTaken() -> Int {
        let probe = client.takeTurn()
        lock.lock()
        defer { lock.unlock() }
        let earlierProbes = probes.count
        probes.append(probe)
        return probe.number - gate.number - 1 - earlierProbes
    }

    /// Opens the gate once `calls` calls have taken a turn behind it, or once
    /// `overtook` is true: an operation that took no turn got past the gate.
    func open(afterCalls calls: Int, orWhen overtook: @escaping @Sendable () -> Bool) async throws {
        try await until { overtook() || self.callTurnsTaken() >= calls }
        await client.pass(turn: gate)
        for probe in takenProbes() {
            await client.pass(turn: probe)
        }
    }

    private func takenProbes() -> [OperationTurn] {
        lock.lock()
        defer { lock.unlock() }
        return probes
    }
}

/// Whether `frame` is a `worker-op` for `method`, on `path` when one is given.
/// A batch is matched on its first write's path. A `path` ending in `/`
/// matches every path under it, for a document whose id is minted.
func isOperation(_ frame: [String: AnySendable], _ method: String, path: String? = nil) -> Bool {
    guard frame["type"]?.stringValue == "worker-op", let op = frame["op"] else { return false }
    guard op["method"]?.stringValue == method else { return false }
    guard let path else { return true }
    let framePath = op["path"]?.stringValue
        ?? op["collectionPath"]?.stringValue
        ?? op["writes"]?.arrayValue?.first?["path"]?.stringValue
    if path.hasSuffix("/") {
        return framePath?.hasPrefix(path) == true
    }
    return framePath == path
}

/// The position of the first frame for `method` (and `path`) the bridge received.
func arrival(_ bridge: FakeReconnectBridge, _ method: String, path: String? = nil) -> Int? {
    bridge.frames.firstIndex { isOperation($0, method, path: path) }
}

func hasArrived(_ bridge: FakeReconnectBridge, _ method: String, path: String? = nil) -> Bool {
    arrival(bridge, method, path: path) != nil
}
