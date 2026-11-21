import Foundation
import Testing
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

private final class RecordedEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func append(_ entry: String) {
        lock.lock()
        entries.append(entry)
        lock.unlock()
    }

    var snapshot: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

@Suite("rtdb-swift Child Event Ordering Suite", .serialized)
struct RtdbChildEventOrderingTests {

    @Test("childEvents stream emits childMoved before childChanged under queryOrderedByValue")
    func childEventsStreamMovedBeforeChanged() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "watched_scores")
        try await ref.setValue(["a": 1, "b": 2, "c": 3])

        let query = ref.queryOrderedByValue()
        var iterator = query.childEvents.makeAsyncIterator()

        let init1 = try await iterator.next()
        let init2 = try await iterator.next()
        let init3 = try await iterator.next()
        #expect([init1?.snapshot.key, init2?.snapshot.key, init3?.snapshot.key] == ["a", "b", "c"])

        try await ref.child("a").setValue(10)

        let firstMutation = try await iterator.next()
        let secondMutation = try await iterator.next()
        #expect(firstMutation?.type == .childMoved)
        #expect(firstMutation?.snapshot.key == "a")
        #expect(firstMutation?.previousSiblingKey == "c")
        #expect(secondMutation?.type == .childChanged)
        #expect(secondMutation?.snapshot.key == "a")
        #expect(secondMutation?.previousSiblingKey == "c")
    }

    @Test("Separate observe handles dispatch childRemoved -> childAdded -> childMoved -> childChanged -> value")
    func separateObserveHandlesCanonicalEventOrder() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "leaderboard")
        try await ref.setValue(["a": 1, "b": 2, "c": 3])

        let query = ref.queryOrderedByValue()
        let timeline = RecordedEvents()

        // Register value and childChanged BEFORE childMoved and childRemoved to prove canonical order wins.
        let valueH = query.observe(.value) { snap in
            timeline.append("value:\(snap.childrenCount)")
        }
        let changedH = query.observe(.childChanged, andPreviousSiblingKeyWith: { snap, prev in
            let v = (snap.value as? NSNumber)?.intValue ?? (snap.value as? Int64).map(Int.init) ?? -1
            timeline.append("changed:\(snap.key ?? "?"):\(v):prev=\(prev ?? "nil")")
        })
        let movedH = query.observe(.childMoved, andPreviousSiblingKeyWith: { snap, prev in
            timeline.append("moved:\(snap.key ?? "?"):prev=\(prev ?? "nil")")
        })
        let addedH = query.observe(.childAdded, andPreviousSiblingKeyWith: { snap, prev in
            timeline.append("added:\(snap.key ?? "?"):prev=\(prev ?? "nil")")
        })
        let removedH = query.observe(.childRemoved) { snap in
            timeline.append("removed:\(snap.key ?? "?")")
        }

        try await waitUntil {
            timeline.snapshot.contains("value:3") && timeline.snapshot.contains("added:c:prev=b")
        }

        // Atomic multi-child update removing b, adding d=0, and updating a=10 -> [d(0), c(3), a(10)].
        try await ref.updateChildValues([
            "b": NSNull(),
            "d": 0,
            "a": 10,
        ])

        try await waitUntil {
            timeline.snapshot.filter { $0 == "value:3" }.count >= 2
        }

        let all = timeline.snapshot
        let remIdx = try #require(all.firstIndex(of: "removed:b"))
        let addIdx = try #require(all.firstIndex(of: "added:d:prev=nil"))
        let movIdx = try #require(all.firstIndex(of: "moved:a:prev=c"))
        let chgIdx = try #require(all.firstIndex(of: "changed:a:10:prev=c"))
        let valAfterIdx = try #require(all.indices.last { all[$0] == "value:3" })

        #expect(remIdx < addIdx)
        #expect(addIdx < movIdx)
        #expect(movIdx < chgIdx)
        #expect(chgIdx < valAfterIdx)
        #expect(!all.contains { $0.hasPrefix("moved:c:") })

        query.removeObserver(withHandle: valueH)
        query.removeObserver(withHandle: changedH)
        query.removeObserver(withHandle: movedH)
        query.removeObserver(withHandle: addedH)
        query.removeObserver(withHandle: removedH)
    }

    @Test("Index#indexedValueChanged suppresses childMoved under queryOrderedByKey and unindexed child edits")
    func indexedValueChangedRules() async throws {
        let harness = try await RtdbTestHarness.create()
        let byKeyRef = harness.database.reference(withPath: "by_key")
        try await byKeyRef.setValue(["a": 1, "b": 2])

        let byKeyTimeline = RecordedEvents()
        let byKeyQuery = byKeyRef.queryOrderedByKey()
        let keyMovedH = byKeyQuery.observe(.childMoved) { snap in
            byKeyTimeline.append("moved:\(snap.key ?? "?")")
        }
        let keyChangedH = byKeyQuery.observe(.childChanged) { snap in
            byKeyTimeline.append("changed:\(snap.key ?? "?")")
        }
        try await Task.sleep(nanoseconds: 25_000_000)
        try await byKeyRef.child("a").setValue(99)
        try await waitUntil { byKeyTimeline.snapshot.contains("changed:a") }
        #expect(byKeyTimeline.snapshot == ["changed:a"])
        byKeyQuery.removeObserver(withHandle: keyMovedH)
        byKeyQuery.removeObserver(withHandle: keyChangedH)

        let byChildRef = harness.database.reference(withPath: "by_child")
        try await byChildRef.setValue([
            "u1": ["score": 10, "label": "init"],
            "u2": ["score": 20, "label": "peer"],
        ])
        let byChildTimeline = RecordedEvents()
        let byChildQuery = byChildRef.queryOrdered(byChild: "score")
        let childChangedH = byChildQuery.observe(.childChanged) { snap in
            byChildTimeline.append("changed:\(snap.key ?? "?")")
        }
        let childMovedH = byChildQuery.observe(.childMoved) { snap in
            byChildTimeline.append("moved:\(snap.key ?? "?")")
        }
        try await Task.sleep(nanoseconds: 25_000_000)

        // Mutating unindexed field `label` emits only childChanged, never childMoved.
        try await byChildRef.child("u1").setValue(["score": 10, "label": "renamed"])
        try await waitUntil { byChildTimeline.snapshot.count == 1 }
        #expect(byChildTimeline.snapshot == ["changed:u1"])

        // Mutating indexed field `score` emits childMoved BEFORE childChanged.
        try await byChildRef.child("u1").setValue(["score": 30, "label": "renamed"])
        try await waitUntil { byChildTimeline.snapshot.count == 3 }
        #expect(byChildTimeline.snapshot == ["changed:u1", "moved:u1", "changed:u1"])

        byChildQuery.removeObserver(withHandle: childChangedH)
        byChildQuery.removeObserver(withHandle: childMovedH)
    }

    private func waitUntil(
        timeoutSeconds: Double = 3.0,
        predicate: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !predicate() {
            if Date() >= deadline {
                Issue.record("Timed out waiting for RTDB child event condition")
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
