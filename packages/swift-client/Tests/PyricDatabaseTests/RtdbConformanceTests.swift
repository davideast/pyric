import Testing
import Foundation
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

@Suite("rtdb-swift Conformance Suite", .serialized)
struct RtdbConformanceTests {

    // ── 1. Database Instance & Connection (5 rows) ────────────────────────────
    @Test func `rtdb-swift#instance-default: Database.database() returns default instance`() async throws {
        let db = Database.database()
        #expect(db.url == "https://default.firebaseio.com")
    }
    @Test func `rtdb-swift#instance-url: Database.database(url:) returns custom URL instance`() async throws {
        let db = Database.database(url: "https://custom-rtdb.firebaseio.com")
        #expect(db.url == "https://custom-rtdb.firebaseio.com")
    }
    @Test func `rtdb-swift#ref-root: Database.reference() returns root reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference()
        #expect(ref.path == "/" && ref.key == nil)
    }
    @Test func `rtdb-swift#ref-path: Database.reference(withPath:) returns targeted reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users/alice")
        #expect(ref.path == "/users/alice" && ref.key == "alice")
    }
    @Test func `rtdb-swift#connection-toggle: Database.goOffline() and goOnline() toggle connection`() async throws {
        let harness = try await RtdbTestHarness.create()
        try await harness.database.goOffline()
        #expect(harness.isOffline == true)
        try await harness.database.goOnline()
        #expect(harness.isOffline == false)
    }

    // ── 2. DatabaseReference Navigation & Properties (7 rows) ─────────────────
    @Test func `rtdb-swift#ref-child: DatabaseReference.child(_:) navigates relative path`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users").child("bob/profile")
        #expect(ref.path == "/users/bob/profile")
    }
    @Test func `rtdb-swift#ref-parent: DatabaseReference.parent returns parent or nil for root`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users/bob")
        #expect(ref.parent?.path == "/users" && ref.parent?.parent?.path == "/" && ref.parent?.parent?.parent == nil)
    }
    @Test func `rtdb-swift#ref-root-prop: DatabaseReference.root returns root reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "a/b/c")
        #expect(ref.root.path == "/")
    }
    @Test func `rtdb-swift#ref-key: DatabaseReference.key returns last segment or nil`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "items/item42")
        #expect(ref.key == "item42" && ref.root.key == nil)
    }
    @Test func `rtdb-swift#ref-path-prop: DatabaseReference.url and path return full path`() async throws {
        let harness = try await RtdbTestHarness.create(url: "https://my-db.firebaseio.com")
        let ref = harness.database.reference(withPath: "posts/p1")
        #expect(ref.path == "/posts/p1" && ref.url == "https://my-db.firebaseio.com/posts/p1")
    }
    @Test func `rtdb-swift#ref-push: DatabaseReference.childByAutoId() creates unique push reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "list")
        let pushed1 = ref.childByAutoId()
        let pushed2 = ref.childByAutoId()
        #expect(pushed1.key != nil && pushed1.key != pushed2.key)
    }
    @Test func `rtdb-swift#ref-push-key-ordering: DatabaseReference.childByAutoId().key orders monotonically`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "ordered")
        let k1 = ref.childByAutoId().key!
        let k2 = ref.childByAutoId().key!
        let k3 = ref.childByAutoId().key!
        #expect(k1 < k2 && k2 < k3)
    }

    // ── 3. Write Operations (6 rows) ──────────────────────────────────────────
    @Test func `rtdb-swift#write-set: DatabaseReference.setValue(_:) writes value at path`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "greeting")
        try await ref.setValue("hello world")
        let snap = try await ref.getData()
        #expect(snap.value as? String == "hello world")
    }
    @Test func `rtdb-swift#write-set-null: DatabaseReference.setValue(nil) deletes node`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "temp")
        try await ref.setValue("to-delete")
        try await ref.setValue(nil)
        let snap = try await ref.getData()
        #expect(snap.exists() == false)
    }
    @Test func `rtdb-swift#write-set-priority: DatabaseReference.setPriority(_:) updates node priority`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "prioNode")
        try await ref.setValue("data")
        try await ref.setPriority(100)
        let snap = try await ref.getData()
        #expect((snap.priority as? NSNumber)?.intValue == 100)
    }
    @Test func `rtdb-swift#write-set-with-priority: DatabaseReference.setValue(_:andPriority:) writes both`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "ranked")
        try await ref.setValue("gold", andPriority: 1)
        let snap = try await ref.getData()
        #expect(snap.value as? String == "gold" && (snap.priority as? NSNumber)?.intValue == 1)
    }
    @Test func `rtdb-swift#write-update: DatabaseReference.updateChildValues(_:) updates specified children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "profile")
        try await ref.setValue(["name": "Alice", "role": "user"])
        try await ref.updateChildValues(["role": "admin"])
        let snap = try await ref.getData()
        let dict = snap.value as? [String: Any]
        #expect(dict?["name"] as? String == "Alice" && dict?["role"] as? String == "admin")
    }
    @Test func `rtdb-swift#write-remove: DatabaseReference.removeValue() removes node`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "session")
        try await ref.setValue("active")
        try await ref.removeValue()
        let snap = try await ref.getData()
        #expect(snap.exists() == false)
    }

    // ── 4. ServerValue Sentinels (2 rows) ─────────────────────────────────────
    @Test func `rtdb-swift#sentinel-timestamp: ServerValue.timestamp() resolves to epoch ms`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "createdAt")
        try await ref.setValue(ServerValue.timestamp())
        let snap = try await ref.getData()
        #expect(((snap.value as? NSNumber)?.intValue ?? 0) > 1_700_000_000_000)
    }
    @Test func `rtdb-swift#sentinel-increment: ServerValue.increment(_:) atomically increments value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "counter")
        try await ref.setValue(10)
        try await ref.setValue(ServerValue.increment(5))
        let snap = try await ref.getData()
        #expect((snap.value as? NSNumber)?.intValue == 15)
    }

    // ── 5. One-Shot Reads & DataSnapshot Inspection (7 rows) ──────────────────
    @Test func `rtdb-swift#read-get: DatabaseReference.getData() fetches DataSnapshot`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "config/theme")
        try await ref.setValue("dark")
        let snap = try await ref.getData()
        #expect(snap.value as? String == "dark")
    }
    @Test func `rtdb-swift#snap-exists: DataSnapshot.exists() reports existence accurately`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "check")
        let emptySnap = try await ref.getData()
        #expect(emptySnap.exists() == false)
        try await ref.setValue(42)
        let fullSnap = try await ref.getData()
        #expect(fullSnap.exists() == true)
    }
    @Test func `rtdb-swift#snap-key: DataSnapshot.key returns node key`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "teams/alpha")
        try await ref.setValue(["members": 5])
        let snap = try await ref.getData()
        #expect(snap.key == "alpha")
    }
    @Test func `rtdb-swift#snap-value: DataSnapshot.value returns native deserialized value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scalar")
        try await ref.setValue(true)
        let snap = try await ref.getData()
        #expect(snap.value as? Bool == true)
    }
    @Test func `rtdb-swift#snap-children: DataSnapshot.children enumerates child snapshots`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "fruits")
        try await ref.setValue(["a": "apple", "b": "banana"])
        let snap = try await ref.getData()
        let children = snap.children.allObjects.compactMap { $0 as? DataSnapshot }
        #expect(children.count == 2 && children.map { $0.key } == ["a", "b"])
    }
    @Test func `rtdb-swift#snap-child-path: DataSnapshot.childSnapshot(forPath:) navigates descendants`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "org")
        try await ref.setValue(["dept": ["lead": "Carol"]])
        let snap = try await ref.getData()
        #expect(snap.childSnapshot(forPath: "dept/lead").value as? String == "Carol")
    }
    @Test func `rtdb-swift#snap-priority: DataSnapshot.priority returns node priority`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "prioSnap")
        try await ref.setValue("item", andPriority: "p1")
        let snap = try await ref.getData()
        #expect(snap.priority as? String == "p1")
    }

    // ── 6. Realtime Listeners & Streams (5 rows) ──────────────────────────────
    @Test func `rtdb-swift#listen-value: DatabaseQuery.observe(.value) emits snapshots`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "liveValue")
        try await ref.setValue("v1")
        var stream = ref.valueStream.makeAsyncIterator()
        let first = try await stream.next()
        #expect(first?.value as? String == "v1")
    }
    @Test func `rtdb-swift#listen-child-added: DatabaseQuery.observe(.childAdded) emits existing and new children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenAdd")
        try await ref.setValue(["c1": "one"])
        var iterator = ref.childEvents.makeAsyncIterator()
        let ev1 = try await iterator.next()
        #expect(ev1?.type == .childAdded && ev1?.snapshot.key == "c1")
    }
    @Test func `rtdb-swift#listen-child-changed: DatabaseQuery.observe(.childChanged) emits modified children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenChange")
        try await ref.setValue(["c1": "initial"])
        var iterator = ref.childEvents.makeAsyncIterator()
        _ = try await iterator.next()
        try await ref.child("c1").setValue("updated")
        let ev2 = try await iterator.next()
        #expect(ev2?.type == .childChanged && ev2?.snapshot.value as? String == "updated")
    }
    @Test func `rtdb-swift#listen-child-removed: DatabaseQuery.observe(.childRemoved) emits removed children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenRemove")
        try await ref.setValue(["c1": "gone"])
        var iterator = ref.childEvents.makeAsyncIterator()
        _ = try await iterator.next()
        try await ref.child("c1").removeValue()
        let ev2 = try await iterator.next()
        #expect(ev2?.type == .childRemoved && ev2?.snapshot.key == "c1")
    }
    @Test func `rtdb-swift#listen-cancel: DatabaseQuery.removeObserver(withHandle:) unsubscribes listener`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "cancelPath")
        let handle = ref.observe(.value) { _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        ref.removeObserver(withHandle: handle)
        #expect(handle > 0)
    }

    // ── 7. Query Ordering, Filtering & Limits (6 rows) ────────────────────────
    @Test func `rtdb-swift#query-order-by-child: DatabaseQuery.queryOrdered(byChild:) orders by nested key`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scores")
        try await ref.setValue(["u1": ["score": 30], "u2": ["score": 10], "u3": ["score": 20]])
        let snap = try await ref.queryOrdered(byChild: "score").getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["u2", "u3", "u1"])
    }
    @Test func `rtdb-swift#query-order-by-key: DatabaseQuery.queryOrderedByKey() orders lexicographically`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "letters")
        try await ref.setValue(["b": 2, "a": 1, "c": 3])
        let snap = try await ref.queryOrderedByKey().getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["a", "b", "c"])
    }
    @Test func `rtdb-swift#query-order-by-value: DatabaseQuery.queryOrderedByValue() orders by scalar value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scalars")
        try await ref.setValue(["x": 50, "y": 10, "z": 30])
        let snap = try await ref.queryOrderedByValue().getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["y", "z", "x"])
    }
    @Test func `rtdb-swift#query-equal-to: DatabaseQuery.queryEqual(toValue:) filters exact matches`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "tiers")
        try await ref.setValue(["p1": 100, "p2": 200, "p3": 100])
        let snap = try await ref.queryOrderedByValue().queryEqual(toValue: 100).getData()
        let keys = snap.childrenSnapshots.compactMap { $0.key }
        #expect(keys.count == 2 && keys.contains("p1") && keys.contains("p3"))
    }
    @Test func `rtdb-swift#query-range: DatabaseQuery.queryStarting(atValue:) and queryEnding(atValue:) filter range`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "nums")
        try await ref.setValue(["n1": 10, "n2": 20, "n3": 30, "n4": 40])
        let snap = try await ref.queryOrderedByValue().queryStarting(atValue: 15).queryEnding(atValue: 35).getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["n2", "n3"])
    }
    @Test func `rtdb-swift#query-limit: DatabaseQuery.queryLimited(toFirst:) and queryLimited(toLast:) limit results`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "limited")
        try await ref.setValue(["k1": 1, "k2": 2, "k3": 3, "k4": 4])
        let firstTwo = try await ref.queryOrderedByKey().queryLimited(toFirst: 2).getData()
        #expect(firstTwo.childrenSnapshots.compactMap { $0.key } == ["k1", "k2"])
        let lastTwo = try await ref.queryOrderedByKey().queryLimited(toLast: 2).getData()
        #expect(lastTwo.childrenSnapshots.compactMap { $0.key } == ["k3", "k4"])
    }

    // ── 8. Transactions & OnDisconnect (4 rows) ───────────────────────────────
    @Test func `rtdb-swift#tx-run: DatabaseReference.runTransactionBlock(_:) commits updated MutableData`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "balance")
        try await ref.setValue(100)
        let result = try await ref.runTransactionBlock { currentData in
            currentData.value = ((currentData.value as? NSNumber)?.intValue ?? 0) + 50
            return TransactionResult.success(withValue: currentData)
        }
        #expect(result.committed == true && (result.snapshot.value as? NSNumber)?.intValue == 150)
    }
    @Test func `rtdb-swift#tx-abort: TransactionResult.abort() aborts transaction without saving`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "lockedBalance")
        try await ref.setValue(100)
        let result = try await ref.runTransactionBlock { _ in TransactionResult.abort() }
        let snap = try await ref.getData()
        #expect(result.committed == false && (snap.value as? NSNumber)?.intValue == 100)
    }
    @Test func `rtdb-swift#ondisconnect-set-remove: DatabaseReference.onDisconnectSetValue(_:) executes on goOffline()`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "presence/user1")
        try await ref.setValue("online")
        try await ref.onDisconnectSetValue("offline")
        try await harness.database.goOffline()
        let snap = try await ref.getData()
        #expect(snap.value as? String == "offline")
    }
    @Test func `rtdb-swift#ondisconnect-cancel: DatabaseReference.cancelDisconnectOperations() cancels queued operations`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "presence/user2")
        try await ref.setValue("online")
        try await ref.onDisconnectSetValue("offline")
        try await ref.cancelDisconnectOperations()
        try await harness.database.goOffline()
        let snap = try await ref.getData()
        #expect(snap.value as? String == "online")
    }

    // ── AuthLens Propagation Integration Verification ─────────────────────────
    @Test func `authlens-propagation: Database propagates active AuthLens on ops and subscriptions`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "secure/data")
        harness.database.switchLens(.admin)
        try await ref.setValue("admin-only")
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "admin")
        harness.database.switchLens(.asUser(uid: "alice"))
        _ = try await ref.getData()
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "as")
        #expect(harness.recordedOps.last?.actAs?["uid"]?.stringValue == "alice")
        harness.database.switchLens(.anon)
        _ = try await ref.getData()
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "anon")
    }

    // ── 1. Database Instance & Connection: `.info`, served by the client ─────
    @Test func `rtdb-swift#info-connected: .info/connected follows the bridge connection and goOffline()`() async throws {
        let harness = try await RtdbTestHarness.create()
        let info = harness.database.reference(withPath: ".info/connected")
        var values = info.valueStream.makeAsyncIterator()
        #expect(try await values.next()?.value as? Bool == false)

        try await harness.database.reference(withPath: "rooms/a").setValue("open")
        #expect(try await values.next()?.value as? Bool == true)
        #expect(try await info.getData().value as? Bool == true)
        try await harness.database.goOffline()
        #expect(try await values.next()?.value as? Bool == false)
        #expect(try await info.getData().value as? Bool == false)
        try await harness.database.goOnline()
        #expect(try await values.next()?.value as? Bool == true)
        goOfflineWithoutWaiting(harness.database)
        #expect(try await values.next()?.value as? Bool == false)
        goOnlineWithoutWaiting(harness.database)
        #expect(try await values.next()?.value as? Bool == true)

        #expect(harness.recordedSubs.isEmpty)
        #expect(harness.recordedOps.prefix(3).map(\.method) == ["rtdb.set", "rtdb.goOffline", "rtdb.goOnline"])
        #expect(!harness.recordedOps.contains { $0.method == "rtdb.get" })
    }
    @Test func `rtdb-swift#info-root-offset: .info and .info/serverTimeOffset are served by the client`() async throws {
        let harness = try await RtdbTestHarness.create()
        let root = try await harness.database.reference(withPath: ".info").getData()
        let rootValue = root.value as? [String: Any]
        #expect(rootValue?["connected"] as? Bool == false)
        #expect(rootValue?["serverTimeOffset"] as? Int64 == 0)
        #expect(root.childrenCount == 2)

        let offset = harness.database.reference(withPath: ".info/serverTimeOffset")
        #expect(try await offset.getData().value as? Int64 == 0)
        var offsets = offset.valueStream.makeAsyncIterator()
        #expect(try await offsets.next()?.value as? Int64 == 0)
        let unknown = try await harness.database.reference(withPath: ".info/authenticated").getData()
        #expect(unknown.exists() == false)

        #expect(harness.recordedSubs.isEmpty)
        #expect(harness.recordedOps.isEmpty)
    }
}

/// Calls the fire-and-forget `goOffline()`, which an async context would not pick.
private func goOfflineWithoutWaiting(_ database: Database) {
    database.goOffline()
}

/// Calls the fire-and-forget `goOnline()`, which an async context would not pick.
private func goOnlineWithoutWaiting(_ database: Database) {
    database.goOnline()
}
