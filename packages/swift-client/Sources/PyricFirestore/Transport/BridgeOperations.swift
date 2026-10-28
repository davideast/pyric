import Foundation

extension PyricBridgeClient {

    /// Reads a document snapshot via getDoc.
    public func getDoc(path: String, actAs: AuthLens? = nil) async throws -> AnySendable {
        try await getDoc(turn: takeTurn(), path: path, actAs: actAs)
    }

    /// Reads a document snapshot via getDoc, in the place `turn` holds.
    package func getDoc(turn: OperationTurn, path: String, actAs: AuthLens?) async throws -> AnySendable {
        try await op(turn: turn, method: "getDoc", params: ["path": .string(path)], actAs: actAs)
    }

    /// Reads query documents via getDocs.
    public func getDocs(source: TargetDescriptor, actAs: AuthLens? = nil) async throws -> AnySendable {
        try await getDocs(turn: takeTurn(), source: source, actAs: actAs)
    }

    /// Reads query documents via getDocs, in the place `turn` holds.
    package func getDocs(turn: OperationTurn, source: TargetDescriptor, actAs: AuthLens?) async throws -> AnySendable {
        try await op(turn: turn, method: "getDocs", params: ["source": source.toAnySendable()], actAs: actAs)
    }

    /// Writes document data via setDoc.
    public func setDoc(
        path: String,
        data: AnySendable,
        options: SetOptionsWire? = nil,
        actAs: AuthLens? = nil
    ) async throws {
        _ = try await op(method: "setDoc", params: Self.setDocParams(path: path, data: data, options: options), actAs: actAs)
    }

    /// Writes document data via setDoc with a Swift dictionary payload.
    public func setDoc(
        path: String,
        data: [String: Any],
        options: SetOptionsWire? = nil,
        actAs: AuthLens? = nil
    ) async throws {
        let encoded = try ValueCodec.encodeWriteData(data)
        try await setDoc(path: path, data: AnySendable.from(encoded), options: options, actAs: actAs)
    }

    /// Updates document fields via updateDoc.
    public func updateDoc(
        path: String,
        data: AnySendable,
        actAs: AuthLens? = nil
    ) async throws {
        _ = try await op(method: "updateDoc", params: Self.updateDocParams(path: path, data: data), actAs: actAs)
    }

    /// Updates document fields via updateDoc with a Swift dictionary payload.
    public func updateDoc(
        path: String,
        data: [String: Any],
        actAs: AuthLens? = nil
    ) async throws {
        let encoded = try ValueCodec.encodeWriteData(data)
        try await updateDoc(path: path, data: AnySendable.from(encoded), actAs: actAs)
    }

    /// Deletes a document via deleteDoc.
    public func deleteDoc(path: String, actAs: AuthLens? = nil) async throws {
        _ = try await op(method: "deleteDoc", params: Self.deleteDocParams(path: path), actAs: actAs)
    }

    /// Creates a document with an auto-minted ID under collectionPath via addDoc.
    public func addDoc(
        collectionPath: String,
        data: AnySendable,
        actAs: AuthLens? = nil
    ) async throws -> (id: String, path: String) {
        let res = try await op(
            method: "addDoc",
            params: [
                "collectionPath": .string(collectionPath),
                "data": data
            ],
            actAs: actAs
        )
        guard let id = res["id"]?.stringValue,
              let path = res["path"]?.stringValue else {
            throw PyricBridgeError.internalError("addDoc response missing id or path: \(res)")
        }
        return (id: id, path: path)
    }

    /// Creates a document with an auto-minted ID under collectionPath via addDoc with a Swift dictionary payload.
    public func addDoc(
        collectionPath: String,
        data: [String: Any],
        actAs: AuthLens? = nil
    ) async throws -> (id: String, path: String) {
        let encoded = try ValueCodec.encodeWriteData(data)
        return try await addDoc(collectionPath: collectionPath, data: AnySendable.from(encoded), actAs: actAs)
    }

    /// Counts matching documents via count.
    public func count(source: TargetDescriptor, actAs: AuthLens? = nil) async throws -> Int {
        try await count(turn: takeTurn(), source: source, actAs: actAs)
    }

    /// Counts matching documents via count, in the place `turn` holds.
    package func count(turn: OperationTurn, source: TargetDescriptor, actAs: AuthLens?) async throws -> Int {
        let res = try await op(
            turn: turn,
            method: "count",
            params: ["source": source.toAnySendable()],
            actAs: actAs
        )
        return Int(res["count"]?.intValue ?? 0)
    }

    /// Performs server-side aggregations via aggregate.
    public func aggregate(
        source: TargetDescriptor,
        spec: [String: AggregateFieldDescriptor],
        actAs: AuthLens? = nil
    ) async throws -> [String: Double?] {
        try await aggregate(turn: takeTurn(), source: source, spec: spec, actAs: actAs)
    }

    /// Performs server-side aggregations via aggregate, in the place `turn` holds.
    package func aggregate(
        turn: OperationTurn,
        source: TargetDescriptor,
        spec: [String: AggregateFieldDescriptor],
        actAs: AuthLens?
    ) async throws -> [String: Double?] {
        let specMap = spec.mapValues { $0.toAnySendable() }
        let res = try await op(
            turn: turn,
            method: "aggregate",
            params: [
                "source": source.toAnySendable(),
                "spec": .dictionary(specMap)
            ],
            actAs: actAs
        )
        guard let data = res["data"]?.dictionaryValue else {
            return [:]
        }
        var result: [String: Double?] = [:]
        for (k, v) in data {
            if v == .null {
                result[k] = nil
            } else {
                result[k] = v.doubleValue
            }
        }
        return result
    }

    /// Atomically commits a batch of write mutations via batchCommit.
    public func batchCommit(writes: [WriteDescriptor], actAs: AuthLens? = nil) async throws {
        _ = try await op(method: "batchCommit", params: Self.batchCommitParams(writes: writes), actAs: actAs)
    }

    /// Commits an interactive transaction via txnCommit.
    public func txnCommit(
        reads: [TxnReadEntry],
        writes: [WriteDescriptor],
        actAs: AuthLens? = nil
    ) async throws {
        _ = try await op(
            method: "txnCommit",
            params: [
                "reads": .array(reads.map { $0.toAnySendable() }),
                "writes": .array(writes.map { $0.toAnySendable() })
            ],
            actAs: actAs
        )
    }
}

// The params of each write operation, shared by the async forms above and the
// completion-block forms that send in call order.
extension PyricBridgeClient {

    static func setDocParams(path: String, data: AnySendable, options: SetOptionsWire?) -> [String: AnySendable] {
        var params: [String: AnySendable] = [
            "path": .string(path),
            "data": data
        ]
        if let options {
            params["options"] = options.toAnySendable()
        }
        return params
    }

    static func updateDocParams(path: String, data: AnySendable) -> [String: AnySendable] {
        ["path": .string(path), "data": data]
    }

    static func deleteDocParams(path: String) -> [String: AnySendable] {
        ["path": .string(path)]
    }

    static func batchCommitParams(writes: [WriteDescriptor]) -> [String: AnySendable] {
        ["writes": .array(writes.map { $0.toAnySendable() })]
    }
}
