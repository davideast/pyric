import Foundation

public enum ServerTimestampBehavior: Int, Sendable {
    case none = 0
    case estimate = 1
    case previous = 2
}

public class DocumentSnapshot: @unchecked Sendable {

    public let firestore: Firestore
    public let reference: DocumentReference
    public let documentID: String
    public let metadata: SnapshotMetadata
    public let exists: Bool
    internal let rawData: [String: Any]?

    public init(
        firestore: Firestore,
        path: String,
        data: [String: Any]?,
        exists: Bool = true,
        metadata: SnapshotMetadata = SnapshotMetadata()
    ) {
        self.firestore = firestore
        self.reference = DocumentReference(firestore: firestore, path: path)
        self.documentID = self.reference.documentID
        self.metadata = metadata
        self.exists = exists
        self.rawData = data
    }

    public init(
        firestore: Firestore,
        reference: DocumentReference,
        metadata: SnapshotMetadata,
        exists: Bool,
        rawData: [String: Any]?
    ) {
        self.firestore = firestore
        self.reference = reference
        self.documentID = reference.documentID
        self.metadata = metadata
        self.exists = exists
        self.rawData = rawData
    }

    public func data() -> [String: Any]? {
        data(with: .none)
    }

    public func data(with serverTimestampBehavior: ServerTimestampBehavior) -> [String: Any]? {
        guard exists, let raw = rawData else { return nil }
        return sanitizeTimestamps(raw, behavior: serverTimestampBehavior)
    }

    public func get(_ field: Any) -> Any? {
        get(field, serverTimestampBehavior: .none)
    }

    public func get(_ field: Any, serverTimestampBehavior: ServerTimestampBehavior) -> Any? {
        guard exists, let raw = rawData else { return nil }
        let segments: [String]
        if let str = field as? String {
            segments = str.components(separatedBy: ".")
        } else if let fp = field as? FieldPath {
            segments = fp.segments
        } else {
            return nil
        }
        return extractNestedField(segments: segments, current: raw, behavior: serverTimestampBehavior)
    }

    public subscript(key: String) -> Any? {
        get { self.get(key) }
    }

    // ── Internal Wire Deserialization ────────────────────────────────────────

    internal static func fromWire(
        firestore: Firestore,
        path: String,
        wire: AnySendable
    ) -> DocumentSnapshot {
        fromWire(firestore: firestore, path: path, wireAny: wire.toAny())
    }

    internal static func fromWire(
        firestore: Firestore,
        path: String,
        wireAny: Any?,
        includeMetadataChanges: Bool = false
    ) -> DocumentSnapshot {
        let docRef = DocumentReference(firestore: firestore, path: path)
        guard let wireDict = wireAny as? [String: Any] else {
            return DocumentSnapshot(
                firestore: firestore,
                reference: docRef,
                metadata: SnapshotMetadata(hasPendingWrites: false, isFromCache: false),
                exists: false,
                rawData: nil
            )
        }

        let resolvedPath = (wireDict["path"] as? String) ?? path
        let resolvedRef = DocumentReference(firestore: firestore, path: resolvedPath)
        let exists = (wireDict["exists"] as? Bool) ?? true

        if !exists && wireDict["exists"] != nil {
            return DocumentSnapshot(
                firestore: firestore,
                reference: resolvedRef,
                metadata: SnapshotMetadata(hasPendingWrites: false, isFromCache: false),
                exists: false,
                rawData: nil
            )
        }

        let rawPayload = wireDict["data"] ?? wireDict
        let decoded = ValueCodec.decodeDocData(rawPayload) { refPath in
            DocumentReference(firestore: firestore, path: refPath)
        }

        return DocumentSnapshot(
            firestore: firestore,
            reference: resolvedRef,
            metadata: SnapshotMetadata(
                hasPendingWrites: (wireDict["hasPendingWrites"] as? Bool) ?? false,
                isFromCache: (wireDict["isFromCache"] as? Bool) ?? false
            ),
            exists: true,
            rawData: decoded
        )
    }

    private func sanitizeTimestamps(_ dict: [String: Any], behavior: ServerTimestampBehavior) -> [String: Any] {
        var result: [String: Any] = [:]
        for (k, v) in dict {
            if let nested = v as? [String: Any] {
                result[k] = sanitizeTimestamps(nested, behavior: behavior)
            } else if let arr = v as? [Any] {
                result[k] = arr.map { item -> Any in
                    if let d = item as? [String: Any] { return sanitizeTimestamps(d, behavior: behavior) }
                    return item
                }
            } else {
                result[k] = v
            }
        }
        return result
    }

    private func extractNestedField(
        segments: [String],
        current: Any?,
        behavior: ServerTimestampBehavior
    ) -> Any? {
        guard let first = segments.first else { return current }
        let remaining = Array(segments.dropFirst())

        if let dict = current as? [String: Any] {
            guard let nextVal = dict[first] else { return nil }
            if remaining.isEmpty {
                return nextVal
            }
            return extractNestedField(segments: remaining, current: nextVal, behavior: behavior)
        }
        return nil
    }
}

public final class QueryDocumentSnapshot: DocumentSnapshot, @unchecked Sendable {
    public init(
        firestore: Firestore,
        path: String,
        data: [String: Any],
        metadata: SnapshotMetadata = SnapshotMetadata()
    ) {
        super.init(firestore: firestore, path: path, data: data, exists: true, metadata: metadata)
    }

    public init(
        firestore: Firestore,
        reference: DocumentReference,
        metadata: SnapshotMetadata,
        rawData: [String: Any]
    ) {
        super.init(firestore: firestore, reference: reference, metadata: metadata, exists: true, rawData: rawData)
    }

    override public func data() -> [String: Any] {
        super.data() ?? [:]
    }

    override public func data(with serverTimestampBehavior: ServerTimestampBehavior) -> [String: Any] {
        super.data(with: serverTimestampBehavior) ?? [:]
    }
}
