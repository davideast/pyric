import Foundation

public enum AuthLens: Sendable, Equatable, ExpressibleByDictionaryLiteral {
    case appSession
    case admin
    case asUser(uid: String, tenant: String?, token: [String: AnySendable]?)
    case anon
    case custom([String: AnySendable])

    public static func asUser(uid: String) -> AuthLens {
        .asUser(uid: uid, tenant: nil, token: nil)
    }

    public static func asUser(uid: String, tenant: String) -> AuthLens {
        .asUser(uid: uid, tenant: tenant, token: nil)
    }

    public static func asUser(uid: String, token: [String: AnySendable]) -> AuthLens {
        .asUser(uid: uid, tenant: nil, token: token)
    }

    public init(dictionaryLiteral elements: (String, AnySendable)...) {
        var dict: [String: AnySendable] = [:]
        for (k, v) in elements {
            dict[k] = v
        }
        if dict["mode"]?.stringValue == "admin" {
            self = .admin
        } else if dict["mode"]?.stringValue == "anon" {
            self = .anon
        } else if dict["mode"]?.stringValue == "as", let uid = dict["uid"]?.stringValue {
            let tenant = dict["tenant"]?.stringValue
            let token = dict["token"]?.dictionaryValue
            self = .asUser(uid: uid, tenant: tenant, token: token)
        } else if dict["mode"]?.stringValue == "app-session" {
            self = .appSession
        } else {
            self = .custom(dict)
        }
    }

    public func toAnySendable() -> AnySendable {
        switch self {
        case .appSession:
            return .dictionary(["mode": .string("app-session")])
        case .admin:
            return .dictionary(["mode": .string("admin")])
        case .asUser(let uid, let tenant, let token):
            var dict: [String: AnySendable] = [
                "mode": .string("as"),
                "uid": .string(uid)
            ]
            if let tenant { dict["tenant"] = .string(tenant) }
            if let token { dict["token"] = .dictionary(token) }
            return .dictionary(dict)
        case .anon:
            return .dictionary(["mode": .string("anon")])
        case .custom(let dict):
            return .dictionary(dict)
        }
    }
}
