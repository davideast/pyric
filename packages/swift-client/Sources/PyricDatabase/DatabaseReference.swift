import Foundation
import PyricFirestore

/// A reference to a specific location in the Realtime Database.
public final class DatabaseReference: DatabaseQuery, @unchecked Sendable {

    public init(database: Database, path: String) {
        let normalized = DatabaseReference.normalizePath(path)
        super.init(database: database, path: normalized)
    }

    internal static func normalizePath(_ raw: String) -> String {
        let parts = raw.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        if parts.isEmpty {
            return "/"
        }
        return "/" + parts.joined(separator: "/")
    }

    /// Returns the parent DatabaseReference, or nil if this is the root reference.
    public var parent: DatabaseReference? {
        if path == "/" {
            return nil
        }
        let parts = path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        if parts.count <= 1 {
            return DatabaseReference(database: database, path: "/")
        }
        let parentPath = "/" + parts.dropLast().joined(separator: "/")
        return DatabaseReference(database: database, path: parentPath)
    }

    /// Returns the root DatabaseReference from any descendant reference.
    public var root: DatabaseReference {
        return DatabaseReference(database: database, path: "/")
    }

    /// Returns the last path segment token of the reference, or nil for the root reference.
    public var key: String? {
        if path == "/" {
            return nil
        }
        return path.split(separator: "/").last.map(String.init)
    }

    /// Returns the full URL of the reference location.
    public var url: String {
        let base = database.url.hasSuffix("/") ? String(database.url.dropLast()) : database.url
        if path == "/" {
            return base
        }
        return base + path
    }

    /// Returns a child DatabaseReference relative to the current path.
    public func child(_ pathString: String) -> DatabaseReference {
        let combined = path == "/" ? "/\(pathString)" : "\(path)/\(pathString)"
        return DatabaseReference(database: database, path: combined)
    }

    /// Generates a new child DatabaseReference with a chronologically ordered unique push ID.
    public func childByAutoId() -> DatabaseReference {
        let autoId = PushIdGenerator.generatePushId()
        return child(autoId)
    }

    // ── Write Operations ──────────────────────────────────────────────────────

    public func setValue(_ value: Any?) async throws {
        if value == nil || value is NSNull {
            try await removeValue()
            return
        }
        let params: [String: AnySendable] = [
            "path": .string(path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        _ = try await database.bridgeClient.op(
            method: "rtdb.set",
            params: params,
            actAs: database.currentAuthLens()
        )
    }

    public func setValue(
        _ value: Any?,
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let sendableValue = RtdbValueCodec.toAnySendable(value)
        Task {
            do {
                try await setValue(sendableValue)
                block(nil, self)
            } catch {
                block(error, self)
            }
        }
    }

    public func setPriority(_ priority: Any?) async throws {
        let params: [String: AnySendable] = [
            "path": .string(path),
            "priority": RtdbValueCodec.toAnySendable(priority)
        ]
        _ = try await database.bridgeClient.op(
            method: "rtdb.setPriority",
            params: params,
            actAs: database.currentAuthLens()
        )
    }

    public func setPriority(
        _ priority: Any?,
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let sendablePriority = RtdbValueCodec.toAnySendable(priority)
        Task {
            do {
                try await setPriority(sendablePriority)
                block(nil, self)
            } catch {
                block(error, self)
            }
        }
    }

    public func setValue(_ value: Any?, andPriority priority: Any?) async throws {
        let params: [String: AnySendable] = [
            "path": .string(path),
            "value": RtdbValueCodec.toAnySendable(value),
            "priority": RtdbValueCodec.toAnySendable(priority)
        ]
        _ = try await database.bridgeClient.op(
            method: "rtdb.setWithPriority",
            params: params,
            actAs: database.currentAuthLens()
        )
    }

    public func setValue(
        _ value: Any?,
        andPriority priority: Any?,
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let sendableValue = RtdbValueCodec.toAnySendable(value)
        let sendablePriority = RtdbValueCodec.toAnySendable(priority)
        Task {
            do {
                try await setValue(sendableValue, andPriority: sendablePriority)
                block(nil, self)
            } catch {
                block(error, self)
            }
        }
    }

    public func updateChildValues(_ values: [AnyHashable: Any]) async throws {
        let params: [String: AnySendable] = [
            "path": .string(path),
            "values": RtdbValueCodec.toAnySendable(values)
        ]
        _ = try await database.bridgeClient.op(
            method: "rtdb.update",
            params: params,
            actAs: database.currentAuthLens()
        )
    }

    public func updateChildValues(
        _ values: [AnyHashable: Any],
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let sendableValues = RtdbValueCodec.toAnySendable(values)
        Task {
            do {
                let params: [String: AnySendable] = [
                    "path": .string(path),
                    "values": sendableValues
                ]
                _ = try await database.bridgeClient.op(
                    method: "rtdb.update",
                    params: params,
                    actAs: database.currentAuthLens()
                )
                block(nil, self)
            } catch {
                block(error, self)
            }
        }
    }

    public func removeValue() async throws {
        let params: [String: AnySendable] = [
            "path": .string(path)
        ]
        _ = try await database.bridgeClient.op(
            method: "rtdb.remove",
            params: params,
            actAs: database.currentAuthLens()
        )
    }

    public func removeValue(
        completionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        Task {
            do {
                try await removeValue()
                block(nil, self)
            } catch {
                block(error, self)
            }
        }
    }

    // ── Transactions ──────────────────────────────────────────────────────────

    public func runTransactionBlock(
        _ block: @escaping @Sendable (MutableData) -> TransactionResult
    ) async throws -> (committed: Bool, snapshot: DataSnapshot) {
        var attempts = 0
        let maxRetries = 25

        while attempts < maxRetries {
            attempts += 1
            let currentSnap = try await getData()
            let mutable = MutableData(
                key: currentSnap.key,
                value: currentSnap.value,
                priority: currentSnap.priority
            )

            let txResult = block(mutable)
            if txResult.isAborted {
                return (committed: false, snapshot: currentSnap)
            }

            let newValue = txResult.mutableData?.value
            let params: [String: AnySendable] = [
                "path": .string(path),
                "expected": RtdbValueCodec.toAnySendable(currentSnap.value),
                "value": RtdbValueCodec.toAnySendable(newValue),
                "applyLocally": .bool(true)
            ]

            let res = try await database.bridgeClient.op(
                method: "rtdb.transactionCommit",
                params: params,
                actAs: database.currentAuthLens()
            )

            let retry = res["retry"]?.boolValue ?? false
            if retry {
                continue
            }

            let committed = res["committed"]?.boolValue ?? true
            if let snapWire = res["snapshot"] {
                let finalSnap = DataSnapshot(wire: snapWire, ref: self)
                return (committed: committed, snapshot: finalSnap)
            } else {
                let finalSnap = try await getData()
                return (committed: committed, snapshot: finalSnap)
            }
        }

        throw PyricBridgeError.unavailable("Transaction failed after maximum retries (\(maxRetries)).")
    }

    public func runTransactionBlock(
        _ block: @escaping @Sendable (MutableData) -> TransactionResult,
        andCompletionBlock completionBlock: @escaping @Sendable (Error?, Bool, DataSnapshot?) -> Void
    ) {
        Task {
            do {
                let result = try await runTransactionBlock(block)
                completionBlock(nil, result.committed, result.snapshot)
            } catch {
                completionBlock(error, false, nil)
            }
        }
    }

    // ── OnDisconnect ──────────────────────────────────────────────────────────

    public func onDisconnect() -> OnDisconnect {
        return OnDisconnect(ref: self)
    }

    public func onDisconnectSetValue(_ value: Any?) async throws {
        try await onDisconnect().setValue(value)
    }

    public func onDisconnectSetValue(_ value: Any?, andPriority priority: Any?) async throws {
        try await onDisconnect().setValue(value, andPriority: priority)
    }

    public func onDisconnectUpdateChildValues(_ values: [AnyHashable: Any]) async throws {
        try await onDisconnect().updateChildValues(values)
    }

    public func onDisconnectRemoveValue() async throws {
        try await onDisconnect().removeValue()
    }

    public func cancelDisconnectOperations() async throws {
        try await onDisconnect().cancel()
    }
}
