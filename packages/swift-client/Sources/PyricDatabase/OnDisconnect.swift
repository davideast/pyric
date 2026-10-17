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
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectSet", params: params)
    }

    public func setValue(_ value: Any?, andPriority priority: Any?) async throws {
        var params: [String: AnySendable] = [
            "path": .string(ref.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let priority {
            params["priority"] = RtdbValueCodec.toAnySendable(priority)
        }
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectSet", params: params)
    }

    public func updateChildValues(_ values: [AnyHashable: Any]) async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path),
            "values": RtdbValueCodec.toAnySendable(values)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectUpdate", params: params)
    }

    public func removeValue() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectRemove", params: params)
    }

    public func cancel() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectCancel", params: params)
    }
}
