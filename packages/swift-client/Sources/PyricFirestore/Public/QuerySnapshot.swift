import Foundation

public final class QuerySnapshot: @unchecked Sendable, RandomAccessCollection {
    public typealias Element = QueryDocumentSnapshot
    public typealias Index = Int

    public let query: Query?
    public let metadata: SnapshotMetadata
    public let documents: [QueryDocumentSnapshot]
    public private(set) var documentChanges: [DocumentChange]

    public var startIndex: Int { documents.startIndex }
    public var endIndex: Int { documents.endIndex }
    public subscript(position: Int) -> QueryDocumentSnapshot { documents[position] }

    public var isEmpty: Bool { documents.isEmpty }
    public var count: Int { documents.count }

    public init(
        documents: [QueryDocumentSnapshot],
        documentChanges: [DocumentChange] = [],
        metadata: SnapshotMetadata = SnapshotMetadata(),
        query: Query? = nil
    ) {
        self.documents = documents
        self.documentChanges = documentChanges
        self.metadata = metadata
        self.query = query
    }

    public func documentChanges(includeMetadataChanges: Bool = false) -> [DocumentChange] {
        documentChanges
    }

    internal static func fromWire(
        firestore: Firestore,
        query: Query,
        wire: AnySendable,
        previousDocs: [QueryDocumentSnapshot]? = nil,
        isFromCache: Bool = false
    ) -> QuerySnapshot {
        fromWire(
            firestore: firestore,
            query: query,
            wireAny: wire.toAny(),
            previousDocs: previousDocs,
            isFromCache: isFromCache
        )
    }

    internal static func fromWire(
        firestore: Firestore,
        query: Query,
        wireAny: Any?,
        previousDocs: [QueryDocumentSnapshot]? = nil,
        isFromCache: Bool = false
    ) -> QuerySnapshot {
        var docList: [QueryDocumentSnapshot] = []
        // Listener frames carry the sandbox snapshot's pending-write state.
        let dictPayload = wireAny as? [String: Any]
        let pending = (dictPayload?["hasPendingWrites"] as? Bool) ?? false
        let queryFromCache = isFromCache || ((dictPayload?["isFromCache"] as? Bool) ?? false)
        let metadata = SnapshotMetadata(hasPendingWrites: pending, isFromCache: queryFromCache)

        if let dict = dictPayload, let docs = dict["docs"] as? [Any] {
            for item in docs {
                let snap = DocumentSnapshot.fromWire(
                    firestore: firestore,
                    path: query.path,
                    wireAny: item,
                    isFromCache: queryFromCache
                )
                if snap.exists {
                    let itemDict = item as? [String: Any]
                    let docPending = (itemDict?["hasPendingWrites"] as? Bool) ?? pending
                    let docMetadata = SnapshotMetadata(hasPendingWrites: docPending, isFromCache: queryFromCache)
                    docList.append(
                        QueryDocumentSnapshot(
                            firestore: firestore,
                            reference: snap.reference,
                            metadata: docMetadata,
                            rawData: snap.rawData ?? [:]
                        )
                    )
                }
            }
        } else if let arr = wireAny as? [Any] {
            for item in arr {
                let snap = DocumentSnapshot.fromWire(
                    firestore: firestore,
                    path: query.path,
                    wireAny: item,
                    isFromCache: queryFromCache
                )
                if snap.exists {
                    let itemDict = item as? [String: Any]
                    let docPending = (itemDict?["hasPendingWrites"] as? Bool) ?? pending
                    let docMetadata = SnapshotMetadata(hasPendingWrites: docPending, isFromCache: queryFromCache)
                    docList.append(
                        QueryDocumentSnapshot(
                            firestore: firestore,
                            reference: snap.reference,
                            metadata: docMetadata,
                            rawData: snap.rawData ?? [:]
                        )
                    )
                }
            }
        }

        let changes = computeChanges(oldDocs: previousDocs, newDocs: docList)
        return QuerySnapshot(
            documents: docList,
            documentChanges: changes,
            metadata: metadata,
            query: query
        )
    }

    private static func computeChanges(
        oldDocs: [QueryDocumentSnapshot]?,
        newDocs: [QueryDocumentSnapshot]
    ) -> [DocumentChange] {
        guard let oldDocs, !oldDocs.isEmpty else {
            return newDocs.enumerated().map { i, doc in
                DocumentChange(
                    type: .added,
                    document: doc,
                    oldIndex: DocumentChange.indexNotFound,
                    newIndex: i
                )
            }
        }

        var changes: [DocumentChange] = []
        var oldMap: [String: (Int, QueryDocumentSnapshot)] = [:]
        for (i, doc) in oldDocs.enumerated() {
            oldMap[doc.documentID] = (i, doc)
        }

        var newMap: [String: (Int, QueryDocumentSnapshot)] = [:]
        for (i, doc) in newDocs.enumerated() {
            newMap[doc.documentID] = (i, doc)
        }

        // Removed
        for (id, (oldIdx, oldDoc)) in oldMap {
            if newMap[id] == nil {
                changes.append(
                    DocumentChange(
                        type: .removed,
                        document: oldDoc,
                        oldIndex: oldIdx,
                        newIndex: DocumentChange.indexNotFound
                    )
                )
            }
        }

        // Added and Modified
        for (id, (newIdx, newDoc)) in newMap {
            if let (oldIdx, oldDoc) = oldMap[id] {
                if !documentValuesEqual(oldDoc.data(), newDoc.data()) {
                    changes.append(
                        DocumentChange(
                            type: .modified,
                            document: newDoc,
                            oldIndex: oldIdx,
                            newIndex: newIdx
                        )
                    )
                }
            } else {
                changes.append(
                    DocumentChange(
                        type: .added,
                        document: newDoc,
                        oldIndex: DocumentChange.indexNotFound,
                        newIndex: newIdx
                    )
                )
            }
        }

        return changes
    }

    private static func documentValuesEqual(_ lhs: Any?, _ rhs: Any?) -> Bool {
        if lhs == nil || lhs is NSNull {
            return rhs == nil || rhs is NSNull
        }
        if rhs == nil || rhs is NSNull {
            return false
        }
        if let lDict = lhs as? [String: Any], let rDict = rhs as? [String: Any] {
            guard lDict.count == rDict.count else { return false }
            for (k, lv) in lDict {
                guard let rv = rDict[k], documentValuesEqual(lv, rv) else { return false }
            }
            return true
        }
        if let lArr = lhs as? [Any], let rArr = rhs as? [Any] {
            guard lArr.count == rArr.count else { return false }
            for (lv, rv) in zip(lArr, rArr) where !documentValuesEqual(lv, rv) {
                return false
            }
            return true
        }
        if let lTs = lhs as? Timestamp, let rTs = rhs as? Timestamp { return lTs == rTs }
        if let lGeo = lhs as? GeoPoint, let rGeo = rhs as? GeoPoint { return lGeo == rGeo }
        if let lData = lhs as? Data, let rData = rhs as? Data { return lData == rData }
        if let lRef = lhs as? DocumentReference, let rRef = rhs as? DocumentReference {
            return lRef.path == rRef.path && lRef.firestore.database == rRef.firestore.database
        }
        return AnySendable.from(lhs) == AnySendable.from(rhs)
    }
}
