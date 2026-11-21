import FirebaseFirestore
import Foundation

private final class SnapshotEventBox: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [(ids: [String], added: [String], modified: [String])] = []
  private var waiters: [(minCount: Int, cont: CheckedContinuation<Void, Never>)] = []

  func append(ids: [String], added: [String], modified: [String]) {
    let ready: [CheckedContinuation<Void, Never>] = {
      lock.lock()
      defer { lock.unlock() }
      events.append((ids: ids, added: added, modified: modified))
      let count = events.count
      var matched: [CheckedContinuation<Void, Never>] = []
      waiters.removeAll { item in
        if count >= item.minCount {
          matched.append(item.cont)
          return true
        }
        return false
      }
      return matched
    }()
    for cont in ready {
      cont.resume()
    }
  }

  func waitForCount(_ minCount: Int, timeoutSeconds: TimeInterval = 10.0) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
      group.addTask {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
          self.lock.lock()
          if self.events.count >= minCount {
            self.lock.unlock()
            cont.resume()
          } else {
            self.waiters.append((minCount: minCount, cont: cont))
            self.lock.unlock()
          }
        }
      }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
        throw NSError(
          domain: "PyricIosFirestoreOracle",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for \(minCount) snapshot events"]
        )
      }
      _ = try await group.next()
      group.cancelAll()
    }
  }

  func snapshot() -> [(ids: [String], added: [String], modified: [String])] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }
}

extension FirestoreOracleProbeRunner {
  static func runQueriesCursorsFiltersAndAggregations(
    db: Firestore,
    runId: String
  ) async throws -> [String: Any] {
    let col = db.collection("pyric_oracle/\(runId)/query_items")
    let d1 = col.document("d1")
    let d2 = col.document("d2")
    let d3 = col.document("d3")
    let d4 = col.document("d4")
    let createdRefs = [d1, d2, d3, d4]
    var activeListener: ListenerRegistration?

    do {
      try await d1.setData(["score": 10, "tier": "free", "badges": ["starter"]])
      try await d2.setData(["score": 20, "tier": "pro", "badges": ["starter", "verified"]])
      try await d3.setData(["score": 30, "tier": "pro", "badges": ["verified", "vip"]])
      try await d4.setData(["score": 40, "tier": "enterprise", "badges": ["vip"]])

      let eqIds = try await col
        .whereField("tier", isEqualTo: "pro")
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let gtIds = try await col
        .whereField("score", isGreaterThan: 15)
        .order(by: "score", descending: false)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let lteIds = try await col
        .whereField("score", isLessThanOrEqualTo: 20)
        .order(by: "score", descending: false)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let inIds = try await col
        .whereField("tier", in: ["free", "enterprise"])
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let arrayContainsIds = try await col
        .whereField("badges", arrayContains: "vip")
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let orFilterIds = try await col
        .whereFilter(
          Filter.orFilter([
            Filter.whereField("tier", isEqualTo: "free"),
            Filter.whereField("tier", isEqualTo: "enterprise"),
          ])
        )
        .getDocuments(source: .server)
        .documents.map(\.documentID)
        .sorted()

      let ascLimitIds = try await col
        .order(by: "score", descending: false)
        .limit(to: 2)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let descLimitIds = try await col
        .order(by: "score", descending: true)
        .limit(to: 2)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let limitToLastIds = try await col
        .order(by: "score", descending: false)
        .limit(toLast: 2)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let cursorWindowIds = try await col
        .order(by: "score", descending: false)
        .start(at: [20])
        .end(before: [40])
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      let d2Snap = try await d2.getDocument(source: .server)
      let afterDocIds = try await col
        .order(by: "score", descending: false)
        .start(afterDocument: d2Snap)
        .getDocuments(source: .server)
        .documents.map(\.documentID)

      // Server-side count, sum, and average aggregations.
      let countField = AggregateField.count()
      let sumField = AggregateField.sum("score")
      let avgField = AggregateField.average("score")
      let aggSnap = try await col
        .aggregate([countField, sumField, avgField])
        .getAggregation(source: .server)
      let aggCount = aggSnap.count.intValue
      let aggSum = (aggSnap.get(sumField) as? NSNumber)?.intValue ?? -1
      let aggAverage = (aggSnap.get(avgField) as? NSNumber)?.doubleValue ?? -1.0

      // Snapshot listener with metadata changes excluded + clean remove().
      let box = SnapshotEventBox()
      let registration = col
        .order(by: "score", descending: false)
        .addSnapshotListener(includeMetadataChanges: false) { snapshot, _ in
          guard let snapshot = snapshot else { return }
          let ids = snapshot.documents.map(\.documentID)
          let added = snapshot.documentChanges
            .filter { $0.type == .added }
            .map { $0.document.documentID }
          let modified = snapshot.documentChanges
            .filter { $0.type == .modified }
            .map { $0.document.documentID }
          box.append(ids: ids, added: added, modified: modified)
        }
      activeListener = registration

      try await box.waitForCount(1)
      try await d2.updateData(["score": 25])
      try await box.waitForCount(2)

      registration.remove()
      activeListener = nil
      let countAtUnsubscribe = box.snapshot().count
      try await d1.updateData(["score": 12])
      try await Task.sleep(nanoseconds: 250_000_000)
      let countAfterUnsubscribe = box.snapshot().count

      let events = box.snapshot()
      let initialListenerIds = events.first?.ids ?? []
      let initialAddedIds = events.first?.added ?? []
      let modifiedIds = events.count >= 2 ? events[1].modified : []

      await deleteDocsBestEffort(createdRefs)

      return [
        "eqIds": eqIds,
        "gtIds": gtIds,
        "lteIds": lteIds,
        "inIds": inIds,
        "arrayContainsIds": arrayContainsIds,
        "orFilterIds": orFilterIds,
        "ascLimitIds": ascLimitIds,
        "descLimitIds": descLimitIds,
        "limitToLastIds": limitToLastIds,
        "cursorWindowIds": cursorWindowIds,
        "afterDocIds": afterDocIds,
        "aggCount": aggCount,
        "aggSum": aggSum,
        "aggAverage": aggAverage,
        "initialListenerIds": initialListenerIds,
        "initialAddedIds": initialAddedIds,
        "secondEventModifiedIds": modifiedIds,
        "noEventsAfterRemove": countAfterUnsubscribe == countAtUnsubscribe,
      ]
    } catch {
      activeListener?.remove()
      await deleteDocsBestEffort(createdRefs)
      throw error
    }
  }
}
