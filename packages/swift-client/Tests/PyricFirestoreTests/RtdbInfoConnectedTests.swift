import Foundation
import Testing
@testable import PyricFirestore
import PyricDatabase

// `.info/connected` on a reconnecting bridge client (ADR-0019, amendment of
// 2026-10-16). Uses deterministic continuation-backed gates (ADR-0019 T1).

private func makeDatabase(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "info-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

private func mentionsInfo(_ frame: [String: AnySendable]) -> Bool {
    String(describing: frame).contains(".info")
}

private func isOp(_ frame: [String: AnySendable], _ method: String, at path: String) -> Bool {
    frame["op"]?["method"]?.stringValue == method && frame["op"]?["path"]?.stringValue == path
}

private func isSub(_ frame: [String: AnySendable], at path: String) -> Bool {
    frame["type"]?.stringValue == "worker-sub" && frame["sub"]?["target"]?["path"]?.stringValue == path
}

/// Observes `.info/connected` and, each time it turns true, registers
/// `onDisconnect().setValue("offline")` and then writes `"online"`, as the
/// Firebase presence sample does.
private func observePresence(_ db: Database, into values: GatedBox<Bool>) -> UInt {
    let status = db.reference(withPath: "status/u1")
    return db.reference(withPath: ".info/connected").observe(.value) { snap in
        let connected = snap.value as? Bool ?? false
        values.append(connected)
        guard connected else { return }
        Task {
            try? await status.onDisconnect().setValue("offline")
            try? await status.setValue("online")
        }
    }
}

/// Answers the presence re-arm sent on the current socket: the onDisconnect
/// registration, then the `online` write it unblocks.
private func answerRearm(_ bridge: GatedBridge, number: Int) async {
    await bridge.waitForOp(method: "rtdb.onDisconnectSet", path: "/status/u1", count: number)
    bridge.answer(bridge.ops(named: "rtdb.onDisconnectSet")[number - 1])
    await bridge.waitForOp(method: "rtdb.set", path: "/status/u1", count: number)
    let statusSets = bridge.ops(named: "rtdb.set").filter { isOp($0, "rtdb.set", at: "/status/u1") }
    bridge.answer(statusSets[number - 1])
}

@Suite("RTDB .info/connected across a reconnect")
struct RtdbInfoConnectedTests {

    @Test("`.info/connected` reports false, true, false, true across a drop and a re-attach, with no repeated value")
    func connectedFollowsTheConnection() async throws {
        let bridge = GatedBridge()
        let clock = TestBridgeClock()
        let client = bridge.makeClient(retryDelay: 0.02)
        await client.setClockForTesting(clock)
        let db = makeDatabase(client)
        let values = GatedBox<Bool>()
        let info = db.reference(withPath: ".info/connected")
        let handle = info.observe(.value) { snap in values.append(snap.value as? Bool ?? false) }
        await values.wait(atLeast: 1)
        #expect(values.all == [false])

        try await client.connect()
        await values.wait(atLeast: 2)
        await interruptGated(bridge, client)
        await values.wait(atLeast: 3)
        // Drive one refused reconnect attempt via the virtual clock; connected must stay single false.
        clock.advance(by: 0.02)
        await client.pass(turn: client.takeTurn())
        #expect(values.count == 3)

        bridge.refuseConnections = false
        clock.advance(by: 0.02)
        await values.wait(atLeast: 4)
        await client.pass(turn: client.takeTurn())
        #expect(values.all == [false, true, false, true])
        #expect(try await info.getData().value as? Bool == true)
        #expect(bridge.frames.filter(mentionsInfo).isEmpty)
        info.removeObserver(withHandle: handle)
        await client.disconnect()
    }

    @Test("A presence re-arm from the `true` callback is sent on the new socket after the replayed listener and the held operation")
    func rearmFollowsTheRestore() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let db = makeDatabase(client)
        let values = GatedBox<Bool>()
        let presence = observePresence(db, into: values)
        await values.wait(atLeast: 1)
        let room = db.reference(withPath: "rooms/a")
        let roomHandle = room.observe(.value) { _ in }
        await bridge.waitForSub(path: "/rooms/a", count: 1)
        await answerRearm(bridge, number: 1)

        await interruptGated(bridge, client)
        let heldDone = SignalGate()
        db.reference(withPath: "rooms/b").setValue(1) { _, _ in heldDone.signal() }
        // Passing a subsequent turn proves the held write is already admitted on the actor.
        await client.pass(turn: client.takeTurn())
        #expect(await client.heldOperationCount == 1)
        #expect(!bridge.frames.contains { isOp($0, "rtdb.set", at: "/rooms/b") })

        bridge.refuseConnections = false
        await answerRearm(bridge, number: 2)
        bridge.answer(bridge.ops(named: "rtdb.set").first { isOp($0, "rtdb.set", at: "/rooms/b") }!)
        await heldDone.wait()

        let frames = bridge.frames
        let reattach = frames.lastIndex { $0["type"]?.stringValue == "attach" }
        let replayed = frames.lastIndex { isSub($0, at: "/rooms/a") }
        let flushed = frames.firstIndex { isOp($0, "rtdb.set", at: "/rooms/b") }
        let rearmed = frames.lastIndex { isOp($0, "rtdb.onDisconnectSet", at: "/status/u1") }
        let online = frames.lastIndex { isOp($0, "rtdb.set", at: "/status/u1") }
        #expect(reattach != nil && replayed != nil && flushed != nil && rearmed != nil && online != nil)
        if let reattach, let replayed, let flushed, let rearmed, let online {
            #expect(replayed > reattach)
            #expect(flushed > replayed)
            #expect(rearmed > flushed)
            #expect(online > rearmed)
        }
        #expect(bridge.socketCount == 2)
        #expect(values.all == [false, true, false, true])
        #expect(bridge.frames.filter(mentionsInfo).isEmpty)
        room.removeObserver(withHandle: roomHandle)
        db.reference(withPath: ".info/connected").removeObserver(withHandle: presence)
        await client.disconnect()
    }

    @Test("On a replaced host the presence re-arm is sent after the Auth restore and the replayed listener")
    func rearmFollowsTheAuthRestoreOnAReplacedHost() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        client.setAuthRestorer { op in
            _ = try await op("auth.restorePortSession", ["uid": .string("u1"), "tenantId": .null])
        }
        let db = makeDatabase(client)
        let values = GatedBox<Bool>()
        let presence = observePresence(db, into: values)
        await values.wait(atLeast: 1)
        let room = db.reference(withPath: "rooms/a")
        let roomHandle = room.observe(.value) { _ in }
        await bridge.waitForSub(path: "/rooms/a", count: 1)
        await answerRearm(bridge, number: 1)

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        await bridge.waitForOp(method: "auth.restorePortSession", count: 1)
        await values.wait(atLeast: 3)
        await client.pass(turn: client.takeTurn())
        #expect(values.all == [false, true, false])
        #expect(bridge.ops(named: "rtdb.onDisconnectSet").count == 1)

        bridge.answer(bridge.ops(named: "auth.restorePortSession")[0], value: ["uid": "u1"])
        await answerRearm(bridge, number: 2)

        let frames = bridge.frames
        let reattach = frames.lastIndex { $0["type"]?.stringValue == "attach" }
        let restored = frames.lastIndex { $0["op"]?["method"]?.stringValue == "auth.restorePortSession" }
        let replayed = frames.lastIndex { isSub($0, at: "/rooms/a") }
        let rearmed = frames.lastIndex { isOp($0, "rtdb.onDisconnectSet", at: "/status/u1") }
        #expect(reattach != nil && restored != nil && replayed != nil && rearmed != nil)
        if let reattach, let restored, let replayed, let rearmed {
            #expect(restored > reattach)
            #expect(replayed > restored)
            #expect(rearmed > replayed)
        }
        #expect(values.all == [false, true, false, true])
        #expect(bridge.frames.filter(mentionsInfo).isEmpty)
        room.removeObserver(withHandle: roomHandle)
        db.reference(withPath: ".info/connected").removeObserver(withHandle: presence)
        await client.disconnect()
    }
}
