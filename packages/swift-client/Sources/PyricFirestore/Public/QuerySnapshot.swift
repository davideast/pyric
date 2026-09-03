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
        previousDocs: [QueryDocumentSnapshot]? = nil
    ) -> QuerySnapshot {
        fromWire(firestore: firestore, query: query, wireAny: wire.toAny(), previousDocs: previousDocs)
    }

    internal static func fromWire(
        firestore: Firestore,
        query: Query,
        wireAny: Any?,
        previousDocs: [QueryDocumentSnapshot]? = nil
    ) -> QuerySnapshot {
        var docList: [QueryDocumentSnapshot] = []

        if let dict = wireAny as? [String: Any], let docs = dict["docs"] as? [Any] {
            for item in docs {
                let snap = DocumentSnapshot.fromWire(
                    firestore: firestore,
                    path: query.path,
                    wireAny: item
                )
                if snap.exists {
                    docList.append(
                        QueryDocumentSnapshot(
                            firestore: firestore,
                            reference: snap.reference,
                            metadata: snap.metadata,
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
                    wireAny: item
                )
                if snap.exists {
                    docList.append(
                        QueryDocumentSnapshot(
                            firestore: firestore,
                            reference: snap.reference,
                            metadata: snap.metadata,
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
            metadata: SnapshotMetadata(hasPendingWrites: false, isFromCache: false),
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
                if !NSDictionary(dictionary: oldDoc.data()).isEqual(to: newDoc.data()) {
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
}
