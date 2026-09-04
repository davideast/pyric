import Foundation

// ─── Wire Frames ─────────────────────────────────────────────────────────────

public struct ClientInfo: Codable, Sendable {
    public let platform: String?
    public let deviceLabel: String?

    public init(platform: String? = "swift", deviceLabel: String? = nil) {
        self.platform = platform
        self.deviceLabel = deviceLabel
    }
}

public struct AttachFrame: Codable, Sendable {
    public let type: String = "attach"
    public let protocolVersion: Int = 1
    public let clientSessionId: String?
    public let clientInfo: ClientInfo?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case clientSessionId
        case clientInfo
    }

    public init(clientSessionId: String? = nil, clientInfo: ClientInfo? = nil) {
        self.clientSessionId = clientSessionId
        self.clientInfo = clientInfo
    }
}

public struct AttachAckFrame: Codable, Sendable {
    public let type: String
    public let protocolVersion: Int?
    public let bridgeVersion: String?
    public let peerConnected: Bool
    public let sandboxConnected: Bool?
    public let clientSessionId: String?
    public let serveVersion: String?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case bridgeVersion
        case peerConnected
        case sandboxConnected
        case clientSessionId
        case serveVersion
    }

    public init(
        type: String = "attach-ack",
        protocolVersion: Int? = 1,
        bridgeVersion: String? = nil,
        peerConnected: Bool = true,
        sandboxConnected: Bool? = nil,
        clientSessionId: String? = nil,
        serveVersion: String? = nil
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.bridgeVersion = bridgeVersion
        self.peerConnected = peerConnected
        self.sandboxConnected = sandboxConnected
        self.clientSessionId = clientSessionId
        self.serveVersion = serveVersion
    }
}

public struct WorkerOpFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let op: [String: AnySendable]

    public init(id: String, op: [String: AnySendable]) {
        self.type = "worker-op"
        self.id = id
        self.op = op
    }
}

public struct WorkerResFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let value: AnySendable?
    public let error: BridgeErrorPayload?

    enum CodingKeys: String, CodingKey {
        case type, id, ok, value, res, error, err
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.type = try container.decode(String.self, forKey: .type)
        self.id = try container.decode(String.self, forKey: .id)
        self.ok = try container.decode(Bool.self, forKey: .ok)
        let val = try? container.decodeIfPresent(AnySendable.self, forKey: .value)
        let res = try? container.decodeIfPresent(AnySendable.self, forKey: .res)
        self.value = val ?? res
        let err = try? container.decodeIfPresent(BridgeErrorPayload.self, forKey: .error)
        let altErr = try? container.decodeIfPresent(BridgeErrorPayload.self, forKey: .err)
        self.error = err ?? altErr
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encodeIfPresent(error, forKey: .error)
    }

    public init(
        type: String = "worker-res",
        id: String,
        ok: Bool,
        value: AnySendable? = nil,
        error: BridgeErrorPayload? = nil
    ) {
        self.type = type
        self.id = id
        self.ok = ok
        self.value = value
        self.error = error
    }
}

public struct BridgeErrorPayload: Codable, Sendable {
    public let code: String
    public let message: String
    public let denialContext: AnySendable?
    public let envelope: AnySendable?

    public init(
        code: String,
        message: String,
        denialContext: AnySendable? = nil,
        envelope: AnySendable? = nil
    ) {
        self.code = code
        self.message = message
        self.denialContext = denialContext
        self.envelope = envelope
    }
}

public struct WorkerSubFrame: Codable, Sendable {
    public let type: String
    public let subId: String
    public let sub: [String: AnySendable]

    public init(subId: String, sub: [String: AnySendable]) {
        self.type = "worker-sub"
        self.subId = subId
        self.sub = sub
    }
}

public struct WorkerUnsubFrame: Codable, Sendable {
    public let type: String
    public let subId: String

    public init(subId: String) {
        self.type = "worker-unsub"
        self.subId = subId
    }
}

public struct WorkerSnapFrame: Codable, Sendable {
    public let type: String
    public let subId: String
    public let value: AnySendable

    public init(type: String = "worker-snap", subId: String, value: AnySendable) {
        self.type = type
        self.subId = subId
        self.value = value
    }
}

public struct PingFrame: Codable, Sendable {
    public let type: String
    public let id: String

    public init(id: String) {
        self.type = "ping"
        self.id = id
    }
}

public struct PongFrame: Codable, Sendable {
    public let type: String
    public let id: String

    public init(id: String) {
        self.type = "pong"
        self.id = id
    }
}
