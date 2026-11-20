import Foundation

public final class QuerySnapshot: @unchecked Sendable, RandomAccessCollection {
    public typealias Element = QueryDocumentSnapshot
    public typealias Index = Int

    public let query: Query?
    public let metadata: SnapshotMetadata
    public let documents: [QueryDocumentSnapshot]
    public private(set) var documentChanges: [DocumentChange]
    private let metadataIncludedChanges: [DocumentChange]?
    private let excludesMetadataChanges: Bool

    public var startIndex: Int { documents.startIndex }
    public var endIndex: Int { documents.endIndex }
    public subscript(position: Int) -> QueryDocumentSnapshot { documents[position] }

    public var isEmpty: Bool { documents.isEmpty }
    public var count: Int { documents.count }

    public init(
        documents: [QueryDocumentSnapshot],
        documentChanges: [DocumentChange] = [],
        metadata: SnapshotMetadata = SnapshotMetadata(),
        query: Query? = nil,
        metadataIncludedChanges: [DocumentChange]? = nil,
        excludesMetadataChanges: Bool = false
    ) {
        self.documents = documents
        self.documentChanges = documentChanges
        self.metadata = metadata
        self.query = query
        self.metadataIncludedChanges = metadataIncludedChanges
        self.excludesMetadataChanges = excludesMetadataChanges
    }

    public func documentChanges(includeMetadataChanges: Bool = false) -> [DocumentChange] {
        if !includeMetadataChanges {
            return documentChanges
        }
        precondition(
            !excludesMetadataChanges,
            "To include metadata changes with your document changes, you must pass includeMetadataChanges: true to addSnapshotListener()."
        )
        return metadataIncludedChanges ?? documentChanges
    }

    internal static func fromWire(
        firestore: Firestore,
        query: Query,
        wire: AnySendable,
        previousDocs: [QueryDocumentSnapshot]? = nil,
        isFromCache: Bool = false,
        excludesMetadataChanges: Bool = false
    ) -> QuerySnapshot {
        fromWire(
            firestore: firestore,
            query: query,
            wireAny: wire.toAny(),
            previousDocs: previousDocs,
            isFromCache: isFromCache,
            excludesMetadataChanges: excludesMetadataChanges
        )
    }

    internal static func fromWire(
        firestore: Firestore,
        query: Query,
        wireAny: Any?,
        previousDocs: [QueryDocumentSnapshot]? = nil,
        isFromCache: Bool = false,
        excludesMetadataChanges: Bool = false
    ) -> QuerySnapshot {
        var docList: [QueryDocumentSnapshot] = []
        let dictPayload = wireAny as? [String: Any]
        let pending = (dictPayload?["hasPendingWrites"] as? Bool) ?? false
        let queryFromCache = isFromCache || ((dictPayload?["isFromCache"] as? Bool) ?? false)
        let metadata = SnapshotMetadata(hasPendingWrites: pending, isFromCache: queryFromCache)

        let rawItems: [Any]
        if let dict = dictPayload, let docs = dict["docs"] as? [Any] {
            rawItems = docs
        } else if let arr = wireAny as? [Any] {
            rawItems = arr
        } else {
            rawItems = []
        }

        for item in rawItems {
            let snap = DocumentSnapshot.fromWire(
                firestore: firestore,
                path: query.path,
                wireAny: item,
                isFromCache: queryFromCache
            )
            if snap.exists {
                let itemDict = item as? [String: Any]
                let docPending = (itemDict?["hasPendingWrites"] as? Bool) ?? pending
                let docFromCache = queryFromCache || ((itemDict?["fromCache"] as? Bool) ?? false)
                let docMetadata = SnapshotMetadata(hasPendingWrites: docPending, isFromCache: docFromCache)
                docList.append(
                    QueryDocumentSnapshot(
                        firestore: firestore,
                        reference: snap.reference,
                        metadata: docMetadata,
                        rawData: snap.rawData ?? [:],
                        noneVariantData: snap.noneVariantData,
                        previousVariantData: snap.previousVariantData
                    )
                )
            }
        }

        let changes = computeChanges(oldDocs: previousDocs, newDocs: docList, includeMetadataChanges: false)
        let metaChanges: [DocumentChange]?
        if excludesMetadataChanges {
            metaChanges = nil
        } else {
            metaChanges = computeChanges(oldDocs: previousDocs, newDocs: docList, includeMetadataChanges: true)
        }
        return QuerySnapshot(
            documents: docList,
            documentChanges: changes,
            metadata: metadata,
            query: query,
            metadataIncludedChanges: metaChanges,
            excludesMetadataChanges: excludesMetadataChanges
        )
    }

    private static func computeChanges(
        oldDocs: [QueryDocumentSnapshot]?,
        newDocs: [QueryDocumentSnapshot],
        includeMetadataChanges: Bool
    ) -> [DocumentChange] {
        guard let oldDocs else {
            return newDocs.enumerated().map { idx, doc in
                DocumentChange(
                    type: .added,
                    document: doc,
                    oldIndex: DocumentChange.indexNotFound,
                    newIndex: idx
                )
            }
        }

        var oldByPath: [String: QueryDocumentSnapshot] = [:]
        for doc in oldDocs {
            oldByPath[doc.reference.path] = doc
        }
        var finalRank: [String: Int] = [:]
        for (idx, doc) in newDocs.enumerated() {
            finalRank[doc.reference.path] = idx
        }

        var working = oldDocs.map { $0.reference.path }
        var changes: [DocumentChange] = []

        // 1. Removed entries in previous order, updating working set sequentially.
        for oldDoc in oldDocs where finalRank[oldDoc.reference.path] == nil {
            let path = oldDoc.reference.path
            guard let oldIdx = working.firstIndex(of: path) else { continue }
            working.remove(at: oldIdx)
            changes.append(
                DocumentChange(
                    type: .removed,
                    document: oldDoc,
                    oldIndex: oldIdx,
                    newIndex: DocumentChange.indexNotFound
                )
            )
        }

        // Unchanged documents already sit in strictly increasing finalRank order inside working.
        var placed = Set<String>()
        for newDoc in newDocs {
            let path = newDoc.reference.path
            if let prior = oldByPath[path] {
                let dataSame = documentValuesEqual(prior.rawData, newDoc.rawData)
                let metadataSame = (prior.metadata == newDoc.metadata)
                let changed = includeMetadataChanges ? (!dataSame || !metadataSame) : !dataSame
                if !changed {
                    placed.insert(path)
                }
            }
        }

        // 2. Added and modified entries in newDocs order, updating working set sequentially.
        for (targetRank, newDoc) in newDocs.enumerated() where !placed.contains(newDoc.reference.path) {
            let path = newDoc.reference.path
            if oldByPath[path] != nil {
                guard let oldIdx = working.firstIndex(of: path) else { continue }
                working.remove(at: oldIdx)
                let afterIdx = working.lastIndex { placed.contains($0) && (finalRank[$0] ?? -1) < targetRank }
                let insertIdx = afterIdx.map { $0 + 1 } ?? 0
                working.insert(path, at: insertIdx)
                placed.insert(path)
                changes.append(
                    DocumentChange(
                        type: .modified,
                        document: newDoc,
                        oldIndex: oldIdx,
                        newIndex: insertIdx
                    )
                )
            } else {
                let afterIdx = working.lastIndex { placed.contains($0) && (finalRank[$0] ?? -1) < targetRank }
                let insertIdx = afterIdx.map { $0 + 1 } ?? 0
                working.insert(path, at: insertIdx)
                placed.insert(path)
                changes.append(
                    DocumentChange(
                        type: .added,
                        document: newDoc,
                        oldIndex: DocumentChange.indexNotFound,
                        newIndex: insertIdx
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
        if let lVec = lhs as? VectorValue, let rVec = rhs as? VectorValue { return lVec == rVec }
        if let lData = lhs as? Data, let rData = rhs as? Data { return lData == rData }
        if let lRef = lhs as? DocumentReference, let rRef = rhs as? DocumentReference {
            return lRef.path == rRef.path && lRef.firestore.database == rRef.firestore.database
        }
        let la = AnySendable.from(lhs)
        let ra = AnySendable.from(rhs)
        if case .double(let ld) = la, case .double(let rd) = ra, ld.isNaN && rd.isNaN {
            return true
        }
        return la == ra
    }
}
