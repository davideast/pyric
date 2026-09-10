import Foundation
import PyricFirestore

/// Registers server-side operations to execute when the client disconnects.
public final class OnDisconnect: NSObject, @unchecked Sendable {
    public let ref: DatabaseReference

    public init(ref: DatabaseReference) {
        self.ref = ref
        super.init()
    }

    public func setValue(_ value: Any?) async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        _ = try await ref.database.bridgeClient.op(
            method: "rtdb.onDisconnectSet",
            params: params,
            actAs: ref.database.currentAuthLens()
        )
    }

    public func setValue(_ value: Any?, andPriority priority: Any?) async throws {
        var params: [String: AnySendable] = [
            "path": .string(ref.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let priority {
            params["priority"] = RtdbValueCodec.toAnySendable(priority)
        }
        _ = try await ref.database.bridgeClient.op(
            method: "rtdb.onDisconnectSet",
            params: params,
            actAs: ref.database.currentAuthLens()
        )
    }

    public func updateChildValues(_ values: [AnyHashable: Any]) async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path),
            "values": RtdbValueCodec.toAnySendable(values)
        ]
        _ = try await ref.database.bridgeClient.op(
            method: "rtdb.onDisconnectUpdate",
            params: params,
            actAs: ref.database.currentAuthLens()
        )
    }

    public func removeValue() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        _ = try await ref.database.bridgeClient.op(
            method: "rtdb.onDisconnectRemove",
            params: params,
            actAs: ref.database.currentAuthLens()
        )
    }

    public func cancel() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        _ = try await ref.database.bridgeClient.op(
            method: "rtdb.onDisconnectCancel",
            params: params,
            actAs: ref.database.currentAuthLens()
        )
    }
}
