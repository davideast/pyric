import Foundation
import Testing
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

private final class ChildTimelineBox: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func append(_ entry: String) {
        lock.lock()
        entries.append(entry)
        lock.unlock()
    }

    func reset() {
        lock.lock()
        entries.removeAll()
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    var snapshot: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

extension LiveHostConformanceTests {

    @Test("SnapshotEvents delivers childRemoved -> childAdded -> childMoved -> childChanged -> value")
    func hermeticSnapshotEventsCanonicalOrder() {
        let app = FirebaseApp(name: "rtdb-snap-order-\(UUID().uuidString)")
        let db = Database(app: app, url: "https://default.firebaseio.com")
        let rootRef = db.reference(withPath: "scores")

        let recorded = ChildTimelineBox()
        let differ = SnapshotEvents(
            eventTypes: [.childRemoved, .childAdded, .childMoved, .childChanged, .value],
            orderBySpec: ["kind": .string("value")],
            onEvent: { ev in
                switch ev.type {
                case .childRemoved:
                    recorded.append("removed:\(ev.snapshot.key ?? "?")")
                case .childAdded:
                    recorded.append("added:\(ev.snapshot.key ?? "?"):prev=\(ev.previousSiblingKey ?? "nil")")
                case .childMoved:
                    recorded.append("moved:\(ev.snapshot.key ?? "?"):prev=\(ev.previousSiblingKey ?? "nil")")
                case .childChanged:
                    let v = self.int64Of(ev.snapshot.value) ?? -1
                    recorded.append("changed:\(ev.snapshot.key ?? "?"):\(v)")
                case .value:
                    recorded.append("value:\(ev.snapshot.childrenCount)")
                }
            }
        )

        let initialWire: AnySendable = .dictionary([
            "key": .string("scores"),
            "exists": .bool(true),
            "value": .dictionary(["a": .int(1), "b": .int(2), "c": .int(3)]),
            "entries": .array([
                .dictionary(["key": .string("a"), "value": .int(1)]),
                .dictionary(["key": .string("b"), "value": .int(2)]),
                .dictionary(["key": .string("c"), "value": .int(3)]),
            ]),
        ])
        differ.deliver(DataSnapshot(wire: initialWire, ref: rootRef))
        #expect(recorded.snapshot == [
            "added:a:prev=nil",
            "added:b:prev=a",
            "added:c:prev=b",
            "value:3",
        ])

        recorded.reset()
        let nextWire: AnySendable = .dictionary([
            "key": .string("scores"),
            "exists": .bool(true),
            "value": .dictionary(["d": .int(0), "c": .int(3), "a": .int(10)]),
            "entries": .array([
                .dictionary(["key": .string("d"), "value": .int(0)]),
                .dictionary(["key": .string("c"), "value": .int(3)]),
                .dictionary(["key": .string("a"), "value": .int(10)]),
            ]),
        ])
        differ.deliver(DataSnapshot(wire: nextWire, ref: rootRef))
        #expect(recorded.snapshot == [
            "removed:b",
            "added:d:prev=nil",
            "moved:a:prev=c",
            "changed:a:10",
            "value:3",
        ])
    }

    @Test("Live host: ordered query delivers childMoved before childChanged across separate observe handles")
    func liveHostOrderedQueryChildMovedBeforeChildChanged() async throws {
        guard let (host, port) = try liveEndpointFromEnv() else {
            return
        }

        try await withRtdbSession(host: host, port: port) { auth, mainDb, _ in
            let email = "rtdb-ord-\(UUID().uuidString.prefix(8))@example.test"
            let created = try await auth.createUser(withEmail: email, password: "correct-horse-battery")
            let uid = created.user.uid
            let scoresRef = mainDb.reference(withPath: "users/\(uid)/scores")
            try await scoresRef.setValue(["a": 1, "b": 2])

            let orderedWatch = scoresRef.queryOrderedByValue()
            let timeline = ChildTimelineBox()

            // Register .childChanged before .childMoved to match the upstream iOS Wave 4 oracle probe.
            let addedHandle = orderedWatch.observe(.childAdded, andPreviousSiblingKeyWith: { snap, prev in
                timeline.append("added:\(snap.key ?? "?"):prev=\(prev ?? "nil")")
            })
            let changedHandle = orderedWatch.observe(.childChanged, andPreviousSiblingKeyWith: { snap, _ in
                let v = self.int64Of(snap.value) ?? -1
                timeline.append("changed:\(snap.key ?? "?"):\(v)")
            })
            let movedHandle = orderedWatch.observe(.childMoved, andPreviousSiblingKeyWith: { snap, prev in
                timeline.append("moved:\(snap.key ?? "?"):prev=\(prev ?? "nil")")
            })
            let removedHandle = orderedWatch.observe(.childRemoved) { snap in
                let v = self.int64Of(snap.value) ?? -1
                timeline.append("removed:\(snap.key ?? "?"):\(v)")
            }

            defer {
                orderedWatch.removeObserver(withHandle: addedHandle)
                orderedWatch.removeObserver(withHandle: changedHandle)
                orderedWatch.removeObserver(withHandle: movedHandle)
                orderedWatch.removeObserver(withHandle: removedHandle)
            }

            try await pollLiveCondition { timeline.count >= 2 }
            #expect(timeline.snapshot == ["added:a:prev=nil", "added:b:prev=a"])

            try await scoresRef.child("c").setValue(3)
            try await pollLiveCondition { timeline.snapshot.contains("added:c:prev=b") }

            try await scoresRef.child("a").setValue(10)
            try await pollLiveCondition {
                let s = timeline.snapshot
                return s.contains("moved:a:prev=c") && s.contains("changed:a:10")
            }

            try await scoresRef.child("b").removeValue()
            try await pollLiveCondition { timeline.snapshot.contains("removed:b:2") }

            #expect(timeline.snapshot == [
                "added:a:prev=nil",
                "added:b:prev=a",
                "added:c:prev=b",
                "moved:a:prev=c",
                "changed:a:10",
                "removed:b:2",
            ])
        }
    }

    private func pollLiveCondition(
        timeoutSeconds: Double = 5.0,
        predicate: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !predicate() {
            if Date() >= deadline {
                Issue.record("Timed out waiting for live-host child-moved condition after \(timeoutSeconds)s")
                return
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
    }
}
