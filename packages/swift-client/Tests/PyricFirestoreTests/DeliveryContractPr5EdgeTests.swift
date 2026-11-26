import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDatabase

private func makeEdgeDatabase(_ client: PyricBridgeClient) -> Database {
    Database(
        app: FirebaseApp(name: "dc5-edge-db-\(UUID().uuidString)"),
        url: "https://default.firebaseio.com",
        bridgeClient: client
    )
}

private func setEnrichHook(_ auth: Auth, _ hook: (@Sendable (User) async -> Void)?) {
    auth.stateLock.lock()
    auth.enrichClaimsForTesting = hook
    auth.stateLock.unlock()
}

@Suite("ADR-0019 delivery contract: PR 5 re-entrancy, hop parity & eviction edges", .serialized)
struct DeliveryContractPr5EdgeTests {

    @Test("S20: RTDB host snapshot enqueued before goOffline delivers ahead of .info/connected false")
    func s20HostFrameBeforeInfoConnectedTransition() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeEdgeDatabase(client)

        let timeline = GatedBox<String>()
        let infoReady = SignalGate()
        let hInfo = db.reference(withPath: ".info/connected").observe(.value) { snap in
            let connected = (snap.value as? Bool) ?? false
            timeline.append("info:\(connected)")
            if connected { infoReady.signal() }
        }
        await infoReady.wait()

        let hRoom = db.reference(withPath: "rooms/a").observe(.value) { snap in
            let v = Int("\(snap.value ?? -1)") ?? -1
            timeline.append("room:\(v)")
        }
        await bridge.waitForSub(path: "/rooms/a", count: 1)
        let subId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/rooms/a"
        }!["subId"]!.stringValue!

        // Hold deliveryQueue so both the host snapshot and goOffline's .info
        // transition queue while deliveryQueue is busy. With single-hop parity,
        // room:1 must strictly precede info:false.
        let queuePaused = SignalGate()
        let releaseQueue = BlockingGate()
        client.deliveryQueue.async {
            queuePaused.signal()
            releaseQueue.wait()
        }
        await queuePaused.wait()

        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["exists": true, "value": 1],
        ])
        bridge.current.deliver([
            "type": "ping",
            "id": "sync-room-1",
        ])
        // receiveLoop processes frames strictly sequentially; seeing pong proves
        // handleWorkerSnap already enqueued room:1 onto deliveryQueue before goOffline().
        await bridge.waitForFrames { frames in
            frames.contains {
                $0["type"]?.stringValue == "pong" && $0["id"]?.stringValue == "sync-room-1"
            }
        }
        let syncGoOffline: () -> Void = { db.goOffline() }
        syncGoOffline()
        releaseQueue.signal()

        await timeline.wait(atLeast: 3)
        let events = timeline.all
        let roomIdx = events.firstIndex(of: "room:1")
        let offlineIdx = events.firstIndex(of: "info:false")
        #expect(roomIdx != nil && offlineIdx != nil)
        if let roomIdx, let offlineIdx {
            #expect(roomIdx < offlineIdx)
        }

        db.reference(withPath: "rooms/a").removeObserver(withHandle: hRoom)
        db.reference(withPath: ".info/connected").removeObserver(withHandle: hInfo)
        await client.disconnect()
    }

    @Test("S24: Re-entrant signOut inside stateListener1 preserves [u1, nil] order without inversion")
    func s24ReentrantSignOutInsideStateListenerPreservesOrder() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let auth = Auth(app: FirebaseApp(name: "dc5-edge-reent-\(UUID().uuidString)"), bridgeClient: client)

        let s1 = GatedBox<String>()
        let s2 = GatedBox<String>()
        let t1 = GatedBox<String>()
        let dynamicSeen = GatedBox<String>()

        final class OnceFlag: @unchecked Sendable {
            private let lock = NSLock()
            private var fired = false
            func tryFire() -> Bool {
                lock.lock()
                defer { lock.unlock() }
                if fired { return false }
                fired = true
                return true
            }
        }
        let once = OnceFlag()
        final class HandleBox: @unchecked Sendable {
            private let lock = NSLock()
            var handle: AuthStateDidChangeListenerHandle?
            func set(_ h: AuthStateDidChangeListenerHandle) { lock.lock(); handle = h; lock.unlock() }
            func get() -> AuthStateDidChangeListenerHandle? { lock.lock(); defer { lock.unlock() }; return handle }
        }
        let dynamicHandle = HandleBox()

        let h1 = auth.addStateDidChangeListener { authRef, user in
            let uid = user?.uid ?? "nil"
            s1.append(uid)
            if uid == "u1" && once.tryFire() {
                try? authRef.signOut()
                let hDyn = authRef.addStateDidChangeListener { _, dynUser in
                    dynamicSeen.append(dynUser?.uid ?? "nil")
                }
                dynamicHandle.set(hDyn)
            }
        }
        let h2 = auth.addStateDidChangeListener { _, user in
            s2.append(user?.uid ?? "nil")
        }
        let ht = auth.addIDTokenDidChangeListener { _, user in
            t1.append(user?.uid ?? "nil")
        }

        auth.applyUserTransition(User(uid: "u1"))
        #expect(auth.currentUser == nil)
        #expect(s1.all == ["nil", "u1", "nil"])
        #expect(s2.all == ["nil", "u1", "nil"])
        #expect(t1.all == ["nil", "u1", "nil"])
        // Dynamically registered after re-entrant signOut: receives initial nil once, no duplicate.
        #expect(dynamicSeen.all == ["nil"])

        auth.removeStateDidChangeListener(h1)
        auth.removeStateDidChangeListener(h2)
        auth.removeIDTokenDidChangeListener(ht)
        if let hDyn = dynamicHandle.get() {
            auth.removeStateDidChangeListener(hDyn)
        }
        await client.disconnect()
    }

    @Test("S24: removeStateDidChangeListener suppresses sibling in-flight and waits across threads")
    func s24RemoveListenerSuppressesSiblingAndWaitsForInFlight() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        let auth = Auth(app: FirebaseApp(name: "dc5-edge-rem-\(UUID().uuidString)"), bridgeClient: client)

        // Part 1: listener1 removes listener2 synchronously during the same transition.
        let s2Seen = GatedBox<String>()
        final class Slot: @unchecked Sendable {
            private let lock = NSLock()
            var h: AuthStateDidChangeListenerHandle?
            func set(_ v: AuthStateDidChangeListenerHandle) { lock.lock(); h = v; lock.unlock() }
            func get() -> AuthStateDidChangeListenerHandle? { lock.lock(); defer { lock.unlock() }; return h }
        }
        let s2Slot = Slot()
        let h2 = auth.addStateDidChangeListener { _, user in
            s2Seen.append(user?.uid ?? "nil")
        }
        s2Slot.set(h2)
        let h1 = auth.addStateDidChangeListener { authRef, user in
            if user?.uid == "u1", let target = s2Slot.get() {
                authRef.removeStateDidChangeListener(target)
            }
        }
        // Dictionary iteration order is randomized; also register a third remover so
        // whichever runs first removes the other, and verify cross-thread wait below.
        let entered = SignalGate()
        let release = BlockingGate()
        let exited = GatedBox<Bool>()
        let afterRemove = GatedBox<Bool>()
        let hBlocked = auth.addStateDidChangeListener { _, user in
            if afterRemove.count > 0 {
                afterRemove.append(true)
            }
            if user?.uid == "block" {
                entered.signal()
                release.wait()
                exited.append(true)
            }
        }

        let transitionDone = SignalGate()
        let transitionQueue = DispatchQueue(label: "dc5.s24.transition")
        transitionQueue.async {
            auth.applyUserTransition(User(uid: "block"))
            transitionDone.signal()
        }
        await entered.wait()

        let removeStarted = SignalGate()
        let removeFinished = SignalGate()
        let exitedBeforeReturn = GatedBox<Bool>()
        let removeQueue = DispatchQueue(label: "dc5.s24.remove")
        removeQueue.async {
            removeStarted.signal()
            auth.removeStateDidChangeListener(hBlocked)
            exitedBeforeReturn.append(exited.count == 1)
            afterRemove.append(true)
            removeFinished.signal()
        }
        await removeStarted.wait()
        release.signal()
        await removeFinished.wait()
        await transitionDone.wait()

        auth.applyUserTransition(User(uid: "after"))
        #expect(exitedBeforeReturn.all == [true])
        #expect(afterRemove.all == [true])

        // Verify sibling removal suppression directly via idToken listener removed during state callback.
        let tokenSeen = GatedBox<String>()
        let hTok = auth.addIDTokenDidChangeListener { _, user in
            tokenSeen.append(user?.uid ?? "nil")
        }
        let hRemover = auth.addStateDidChangeListener { authRef, user in
            if user?.uid == "drop-token" {
                authRef.removeIDTokenDidChangeListener(hTok)
            }
        }
        auth.applyUserTransition(User(uid: "drop-token"))
        #expect(tokenSeen.all == ["after"])

        auth.removeStateDidChangeListener(h1)
        auth.removeStateDidChangeListener(h2)
        auth.removeStateDidChangeListener(hRemover)
        await client.disconnect()
    }

    @Test("S21: Stale remote enrichUserClaimsIfLive result is dropped after local signOut")
    func s21StaleRemoteEnrichmentDroppedAfterSignOut() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let auth = Auth(app: FirebaseApp(name: "dc5-edge-s21-\(UUID().uuidString)"), bridgeClient: client)

        let enrichEntered = SignalGate()
        let releaseEnrich = SignalGate()
        setEnrichHook(auth) { _ in
            enrichEntered.signal()
            await releaseEnrich.wait()
        }

        auth.startRemoteSync()
        await bridge.waitForSub(target: "authState", count: 1)
        await bridge.waitForSub(target: "idToken", count: 1)
        let sState = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?.stringValue == "authState"
        }!["subId"]!.stringValue!

        bridge.current.deliver([
            "type": "worker-snap",
            "subId": sState,
            "value": ["user": ["uid": "stale-user"]],
        ])
        await enrichEntered.wait()

        // Local signOut advances userTransitionVersion while enrichment is suspended.
        try auth.signOut()
        #expect(auth.currentUser == nil)

        // Release stale enrichment, then send a sentinel frame on the same merged stream
        // to prove the stale frame has finished processing without resurrecting stale-user.
        let sawSentinel = SignalGate()
        let hCheck = auth.addStateDidChangeListener { _, user in
            if user?.uid == "fresh-user" {
                sawSentinel.signal()
            }
        }
        let observed = GatedBox<String>()
        let hObs = auth.addStateDidChangeListener { _, user in
            observed.append(user?.uid ?? "nil")
        }
        setEnrichHook(auth, nil)

        releaseEnrich.signal()
        bridge.current.deliver([
            "type": "worker-snap",
            "subId": sState,
            "value": ["user": ["uid": "fresh-user", "claims": ["firebase": ["sign_in_provider": "custom"]]]],
        ])
        await sawSentinel.wait()
        #expect(!observed.all.contains("stale-user"))
        #expect(auth.currentUser?.uid == "fresh-user")

        auth.removeStateDidChangeListener(hCheck)
        auth.removeStateDidChangeListener(hObs)
        await client.disconnect()
    }

    @Test("S27: removeObserver racing evictErroredView blocks until onCancel exits and suppresses queued cancel")
    func s27RemoveObserverRacingErrorEvictionWaitsForCancelCallback() async throws {
        let bridge = GatedBridge()
        let client = bridge.makeClient()
        try await client.connect()
        let db = makeEdgeDatabase(client)
        let ref = db.reference(withPath: "s27/err-race")

        let cancelEntered = SignalGate()
        let releaseCancel = BlockingGate()
        let cancelExited = GatedBox<Bool>()
        let afterRemove1 = GatedBox<Bool>()
        let cancel2Called = GatedBox<Bool>()

        let h1 = ref.observe(.value, with: { _ in }, withCancel: { _ in
            if afterRemove1.count > 0 { afterRemove1.append(true) }
            cancelEntered.signal()
            releaseCancel.wait()
            cancelExited.append(true)
        })
        let h2 = ref.observe(.value, with: { _ in }, withCancel: { _ in
            cancel2Called.append(true)
        })
        await bridge.waitForSub(path: "/s27/err-race", count: 1)
        let subId = bridge.subs(onSocket: 1).first {
            $0["sub"]?["target"]?["path"]?.stringValue == "/s27/err-race"
        }!["subId"]!.stringValue!

        bridge.current.deliver([
            "type": "worker-snap",
            "subId": subId,
            "value": ["__error": ["code": "permission-denied", "message": "denied"]],
        ])
        await cancelEntered.wait()

        // h2's deliverCancel is already queued behind h1 on deliveryQueue after handleError
        // drained records and evicted the view. Removing h2 must suppress its queued onCancel,
        // and removing h1 must block until h1's in-flight onCancel exits.
        ref.removeObserver(withHandle: h2)
        let remove1Started = SignalGate()
        let remove1Finished = SignalGate()
        let exitedBeforeReturn = GatedBox<Bool>()
        let remove1Queue = DispatchQueue(label: "dc5.s27.rtdb.remove")
        remove1Queue.async {
            remove1Started.signal()
            ref.removeObserver(withHandle: h1)
            exitedBeforeReturn.append(cancelExited.count == 1)
            afterRemove1.append(true)
            remove1Finished.signal()
        }
        await remove1Started.wait()
        releaseCancel.signal()
        await remove1Finished.wait()

        // Drain deliveryQueue once more to confirm h2's queued cancel was suppressed.
        let drained = SignalGate()
        client.deliveryQueue.async { drained.signal() }
        await drained.wait()

        #expect(exitedBeforeReturn.all == [true])
        #expect(afterRemove1.all == [true])
        #expect(cancel2Called.count == 0)
        await client.disconnect()
    }
}
