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
    internal let noneVariantData: [String: Any]?
    internal let previousVariantData: [String: Any]?

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
        self.noneVariantData = nil
        self.previousVariantData = nil
    }

    public init(
        firestore: Firestore,
        reference: DocumentReference,
        metadata: SnapshotMetadata,
        exists: Bool,
        rawData: [String: Any]?,
        noneVariantData: [String: Any]? = nil,
        previousVariantData: [String: Any]? = nil
    ) {
        self.firestore = firestore
        self.reference = reference
        self.documentID = reference.documentID
        self.metadata = metadata
        self.exists = exists
        self.rawData = rawData
        self.noneVariantData = noneVariantData
        self.previousVariantData = previousVariantData
    }

    public func data() -> [String: Any]? {
        data(with: .none)
    }

    public func data(with serverTimestampBehavior: ServerTimestampBehavior) -> [String: Any]? {
        guard let selected = selectVariantDictionary(behavior: serverTimestampBehavior) else {
            return nil
        }
        return cloneDictionary(selected)
    }

    public func get(_ field: Any) -> Any? {
        get(field, serverTimestampBehavior: .none)
    }

    public func get(_ field: Any, serverTimestampBehavior: ServerTimestampBehavior) -> Any? {
        guard exists else { return nil }
        let segments: [String]
        if let str = field as? String {
            guard !str.isEmpty else { return nil }
            if str == "__name__" {
                return documentID
            }
            segments = str.components(separatedBy: ".")
        } else if let fp = field as? FieldPath {
            if fp == FieldPath.documentID() {
                return documentID
            }
            segments = fp.segments
        } else {
            return nil
        }
        guard let selected = selectVariantDictionary(behavior: serverTimestampBehavior) else {
            return nil
        }
        return extractNestedField(segments: segments, current: selected)
    }

    public subscript(key: String) -> Any? {
        get { self.get(key) }
    }

    public subscript(path: FieldPath) -> Any? {
        get { self.get(path) }
    }

    private func selectVariantDictionary(behavior: ServerTimestampBehavior) -> [String: Any]? {
        guard exists, let raw = rawData else { return nil }
        guard metadata.hasPendingWrites else { return raw }
        switch behavior {
        case .estimate:
            return raw
        case .none:
            return noneVariantData ?? raw
        case .previous:
            return previousVariantData ?? raw
        }
    }

    // -- Internal Wire Deserialization --

    internal static func fromWire(
        firestore: Firestore,
        path: String,
        wire: AnySendable,
        isFromCache: Bool = false
    ) -> DocumentSnapshot {
        fromWire(firestore: firestore, path: path, wireAny: wire.toAny(), isFromCache: isFromCache)
    }

    internal static func fromWire(
        firestore: Firestore,
        path: String,
        wireAny: Any?,
        includeMetadataChanges: Bool = false,
        isFromCache: Bool = false
    ) -> DocumentSnapshot {
        let docRef = DocumentReference(firestore: firestore, path: path)
        guard let wireDict = wireAny as? [String: Any] else {
            return DocumentSnapshot(
                firestore: firestore,
                reference: docRef,
                metadata: SnapshotMetadata(hasPendingWrites: false, isFromCache: isFromCache),
                exists: false,
                rawData: nil
            )
        }

        let resolvedPath = (wireDict["path"] as? String) ?? path
        let resolvedRef = DocumentReference(firestore: firestore, path: resolvedPath)
        let exists = (wireDict["exists"] as? Bool) ?? true
        let resolvedPending = (wireDict["hasPendingWrites"] as? Bool) ?? false
        let resolvedFromCache = isFromCache || ((wireDict["isFromCache"] as? Bool) ?? false)

        if !exists && wireDict["exists"] != nil {
            return DocumentSnapshot(
                firestore: firestore,
                reference: resolvedRef,
                metadata: SnapshotMetadata(hasPendingWrites: resolvedPending, isFromCache: resolvedFromCache),
                exists: false,
                rawData: nil
            )
        }

        let resolver: DocumentReferenceResolver = { refPath in
            DocumentReference(firestore: firestore, path: refPath)
        }
        let rawPayload = wireDict["data"] ?? wireDict
        let decoded = ValueCodec.decodeDocData(rawPayload, referenceResolver: resolver)

        var decodedNone: [String: Any]?
        var decodedPrevious: [String: Any]?
        if let variants = wireDict["serverTimestampVariants"] as? [String: Any] {
            if let rawNone = variants["none"] {
                decodedNone = ValueCodec.decodeDocData(rawNone, referenceResolver: resolver)
            }
            if let rawPrevious = variants["previous"] {
                decodedPrevious = ValueCodec.decodeDocData(rawPrevious, referenceResolver: resolver)
            }
        }

        return DocumentSnapshot(
            firestore: firestore,
            reference: resolvedRef,
            metadata: SnapshotMetadata(
                hasPendingWrites: resolvedPending,
                isFromCache: resolvedFromCache
            ),
            exists: true,
            rawData: decoded,
            noneVariantData: decodedNone,
            previousVariantData: decodedPrevious
        )
    }

    private func cloneDictionary(_ dict: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (k, v) in dict {
            result[k] = cloneValue(v)
        }
        return result
    }

    private func cloneValue(_ value: Any) -> Any {
        if let nested = value as? [String: Any] {
            return cloneDictionary(nested)
        }
        if let arr = value as? [Any] {
            return arr.map { cloneValue($0) }
        }
        return value
    }

    private func extractNestedField(segments: [String], current: Any?) -> Any? {
        guard let first = segments.first else { return current }
        let remaining = Array(segments.dropFirst())
        if let dict = current as? [String: Any] {
            guard let nextVal = dict[first] else { return nil }
            if remaining.isEmpty {
                return cloneValue(nextVal)
            }
            return extractNestedField(segments: remaining, current: nextVal)
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
        rawData: [String: Any],
        noneVariantData: [String: Any]? = nil,
        previousVariantData: [String: Any]? = nil
    ) {
        super.init(
            firestore: firestore,
            reference: reference,
            metadata: metadata,
            exists: true,
            rawData: rawData,
            noneVariantData: noneVariantData,
            previousVariantData: previousVariantData
        )
    }

    override public func data() -> [String: Any] {
        super.data() ?? [:]
    }

    override public func data(with serverTimestampBehavior: ServerTimestampBehavior) -> [String: Any] {
        super.data(with: serverTimestampBehavior) ?? [:]
    }
}
