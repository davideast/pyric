import Foundation

public final class CollectionReference: Query, @unchecked Sendable {

    override public var collectionID: String {
        guard let last = path.components(separatedBy: "/").last else { return "" }
        return last
    }

    public var parent: DocumentReference? {
        let segments = path.components(separatedBy: "/")
        if segments.count <= 1 { return nil }
        let parentPath = segments.dropLast().joined(separator: "/")
        return DocumentReference(firestore: firestore, path: parentPath)
    }

    public init(firestore: Firestore, path: String) {
        super.init(firestore: firestore, rootSource: .collection(path: path), path: path)
    }

    // ── Document Accessors ───────────────────────────────────────────────────

    public func document() -> DocumentReference {
        let autoId = AutoId.new()
        return DocumentReference(firestore: firestore, path: "\(path)/\(autoId)")
    }

    public func document(_ documentPath: String) -> DocumentReference {
        let clean = documentPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        precondition(!clean.isEmpty, "Document path must not be empty.")
        return DocumentReference(firestore: firestore, path: "\(path)/\(clean)")
    }

    // ── Document Insertion ───────────────────────────────────────────────────

    @discardableResult
    public func addDocument(data: [String: Any]) async throws -> DocumentReference {
        let docRef = document()
        try await docRef.setData(data)
        return docRef
    }

    @discardableResult
    public func addDocument(
        data: [String: Any],
        completion: (@Sendable (Error?) -> Void)? = nil
    ) -> DocumentReference {
        let docRef = document()
        docRef.setData(data, completion: completion)
        return docRef
    }
}
