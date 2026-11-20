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
        if value == nil || value is NSNull {
            try await removeValue()
            return
        }
        let params: [String: AnySendable] = [
            "path": .string(ref.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectSet", params: params)
    }

    public func setValue(
        _ value: Any?,
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        if value == nil || value is NSNull {
            removeValue(completionBlock: block)
            return
        }
        let targetRef = ref
        let params: [String: AnySendable] = [
            "path": .string(targetRef.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        targetRef.database.sendInCallOrder(method: "rtdb.onDisconnectSet", params: params) { error in
            block(error, targetRef)
        }
    }

    public func setValue(_ value: Any?, andPriority priority: Any?) async throws {
        if value == nil || value is NSNull {
            try await removeValue()
            return
        }
        var params: [String: AnySendable] = [
            "path": .string(ref.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let priority {
            params["priority"] = RtdbValueCodec.toAnySendable(priority)
        }
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectSet", params: params)
    }

    public func setValue(
        _ value: Any?,
        andPriority priority: Any?,
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        if value == nil || value is NSNull {
            removeValue(completionBlock: block)
            return
        }
        let targetRef = ref
        var params: [String: AnySendable] = [
            "path": .string(targetRef.path),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let priority {
            params["priority"] = RtdbValueCodec.toAnySendable(priority)
        }
        targetRef.database.sendInCallOrder(method: "rtdb.onDisconnectSet", params: params) { error in
            block(error, targetRef)
        }
    }

    public func updateChildValues(_ values: [AnyHashable: Any]) async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path),
            "values": RtdbValueCodec.toAnySendable(values)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectUpdate", params: params)
    }

    public func updateChildValues(
        _ values: [AnyHashable: Any],
        withCompletionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let targetRef = ref
        let params: [String: AnySendable] = [
            "path": .string(targetRef.path),
            "values": RtdbValueCodec.toAnySendable(values)
        ]
        targetRef.database.sendInCallOrder(method: "rtdb.onDisconnectUpdate", params: params) { error in
            block(error, targetRef)
        }
    }

    public func removeValue() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectRemove", params: params)
    }

    public func removeValue(
        completionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let targetRef = ref
        let params: [String: AnySendable] = [
            "path": .string(targetRef.path)
        ]
        targetRef.database.sendInCallOrder(method: "rtdb.onDisconnectRemove", params: params) { error in
            block(error, targetRef)
        }
    }

    public func cancel() async throws {
        let params: [String: AnySendable] = [
            "path": .string(ref.path)
        ]
        try await ref.database.send(turn: ref.database.takeTurn(), method: "rtdb.onDisconnectCancel", params: params)
    }

    public func cancel(
        completionBlock block: @escaping @Sendable (Error?, DatabaseReference) -> Void
    ) {
        let targetRef = ref
        let params: [String: AnySendable] = [
            "path": .string(targetRef.path)
        ]
        targetRef.database.sendInCallOrder(method: "rtdb.onDisconnectCancel", params: params) { error in
            block(error, targetRef)
        }
    }
}
