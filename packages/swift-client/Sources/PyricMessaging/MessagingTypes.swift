import Foundation
import PyricFirestore

/// Status for a downstream message received by the app, matching `FIRMessagingMessageStatus`.
public enum MessagingMessageStatus: Int, Sendable, Equatable, Hashable, CaseIterable {
    /// Unknown message status (`FIRMessagingMessageStatusUnknown = 0`).
    case unknown = 0
    /// New downstream message received by the app (`FIRMessagingMessageStatusNew = 1`).
    case new = 1
}

/// APNs device token environment type, matching `FIRMessagingAPNSTokenType`.
public enum MessagingAPNSTokenType: Int, Sendable, Equatable, Hashable, CaseIterable {
    /// Automatically infer environment from provisioning profile (`FIRMessagingAPNSTokenTypeUnknown = 0`).
    case unknown = 0
    /// Sandbox / debug APNs environment (`FIRMessagingAPNSTokenTypeSandbox = 1`).
    case sandbox = 1
    /// Production APNs environment (`FIRMessagingAPNSTokenTypeProd = 2`).
    case prod = 2
}

/// Information about a downstream message inspected by `Messaging.appDidReceiveMessage(_:)`,
/// matching `FIRMessagingMessageInfo` (`MessagingMessageInfo`).
public final class MessagingMessageInfo: NSObject, Sendable {
    public let status: MessagingMessageStatus

    public init(status: MessagingMessageStatus = .unknown) {
        self.status = status
        super.init()
    }
}

/// Delegate protocol receiving registration and token refresh callbacks from `Messaging`,
/// matching `FIRMessagingDelegate` (`MessagingDelegate`) in `FirebaseMessaging 13.2.0`.
public protocol MessagingDelegate: AnyObject {
    /// Invoked whenever an FCM registration token is minted or refreshed.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?)

    /// Invoked whenever the app instance registers with FCM via `register()`.
    func messaging(_ messaging: Messaging, didReceiveRegistration installationID: String?)

    /// Invoked when the app instance unregisters from FCM via `unregister()`.
    func messaging(_ messaging: Messaging, didUnregister installationID: String)
}

public extension MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {}
    func messaging(_ messaging: Messaging, didReceiveRegistration installationID: String?) {}
    func messaging(_ messaging: Messaging, didUnregister installationID: String) {}
}

/// Simulated client visibility state controlling whether the Pyric `MessagingBroker`
/// routes deliveries to `messaging.foreground` or `messaging.background`.
public enum MessagingVisibilityState: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case visible = "visible"
    case hidden = "hidden"
}

/// Route chosen by the Pyric `MessagingBroker` for a delivered message.
public enum MessagingDeliveryRoute: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case foreground = "foreground"
    case background = "background"
}

/// Delivery lifecycle stage accepted by `messaging.acknowledge`.
public enum MessagingDeliveryStage: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case received = "received"
    case handlerCompleted = "handler-completed"
    case handlerRejected = "handler-rejected"
    case displayRequested = "display-requested"
    case displayAccepted = "display-accepted"
    case displayRejected = "display-rejected"
}

/// Notification display fields carried on a Cloud Messaging payload.
public struct MessagingNotificationPayload: Codable, Sendable, Equatable, Hashable {
    public let title: String?
    public let body: String?
    public let imageURL: String?

    public init(title: String? = nil, body: String? = nil, imageURL: String? = nil) {
        self.title = title
        self.body = body
        self.imageURL = imageURL
    }

    package func toDeliverWire() -> [String: AnySendable] {
        var out: [String: AnySendable] = [:]
        if let title { out["title"] = .string(title) }
        if let body { out["body"] = .string(body) }
        if let imageURL { out["image"] = .string(imageURL) }
        return out
    }

    package func toSendWire() -> [String: AnySendable] {
        var out: [String: AnySendable] = [:]
        if let title { out["title"] = .string(title) }
        if let body { out["body"] = .string(body) }
        if let imageURL { out["imageUrl"] = .string(imageURL) }
        return out
    }

    package static func fromWire(_ raw: AnySendable?) -> MessagingNotificationPayload? {
        guard let dict = raw?.dictionaryValue else {
            return nil
        }
        let title = dict["title"]?.stringValue
        let body = dict["body"]?.stringValue
        let imageURL = dict["image"]?.stringValue ?? dict["imageUrl"]?.stringValue
        return MessagingNotificationPayload(title: title, body: body, imageURL: imageURL)
    }
}

/// Downstream message delivered over Pyric's `messaging.foreground` or `messaging.background` stream.
public struct RemoteMessagingMessage: Sendable, Equatable, Hashable {
    public let messageID: String
    public var messageId: String { messageID }
    public let from: String
    public let data: [String: String]
    public let notification: MessagingNotificationPayload?
    public let route: MessagingDeliveryRoute?
    public let subscriptionID: String?

    public init(
        messageID: String,
        from: String,
        data: [String: String] = [:],
        notification: MessagingNotificationPayload? = nil,
        route: MessagingDeliveryRoute? = nil,
        subscriptionID: String? = nil
    ) {
        self.messageID = messageID
        self.from = from
        self.data = data
        self.notification = notification
        self.route = route
        self.subscriptionID = subscriptionID
    }

    /// Converts this delivery into a standard iOS APNs/FCM `userInfo` dictionary suitable for
    /// `Messaging.appDidReceiveMessage(_:)` and `Messaging.serviceExtension()`.
    public func toUserInfo() -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [:]
        for (key, value) in data {
            info[key] = value
        }
        info["gcm.message_id"] = messageID
        info["from"] = from
        info["google.c.sender.id"] = from

        if let notification {
            var alert: [String: Any] = [:]
            if let title = notification.title { alert["title"] = title }
            if let body = notification.body { alert["body"] = body }
            var aps: [String: Any] = [:]
            if !alert.isEmpty {
                aps["alert"] = alert
            } else {
                aps["content-available"] = 1
            }
            info["aps"] = aps
            if let imageURL = notification.imageURL {
                info["fcm_options"] = ["image": imageURL]
            }
        } else {
            info["aps"] = ["content-available": 1]
        }
        return info
    }

    public static func fromDeliveredPayload(
        _ raw: AnySendable,
        route: MessagingDeliveryRoute? = nil,
        subscriptionID: String? = nil
    ) -> RemoteMessagingMessage? {
        guard let dict = raw.dictionaryValue else {
            return nil
        }
        let messageID = dict["messageId"]?.stringValue ?? ""
        let from = dict["from"]?.stringValue ?? ""
        guard !messageID.isEmpty || !from.isEmpty else {
            return nil
        }
        var parsedData: [String: String] = [:]
        if let rawData = dict["data"]?.dictionaryValue {
            for (key, val) in rawData {
                if let str = val.stringValue {
                    parsedData[key] = str
                } else if let intVal = val.intValue {
                    parsedData[key] = String(intVal)
                } else if let dblVal = val.doubleValue {
                    parsedData[key] = String(dblVal)
                } else if let boolVal = val.boolValue {
                    parsedData[key] = String(boolVal)
                }
            }
        }
        let parsedNotification = MessagingNotificationPayload.fromWire(dict["notification"])
        return RemoteMessagingMessage(
            messageID: messageID,
            from: from,
            data: parsedData,
            notification: parsedNotification,
            route: route,
            subscriptionID: subscriptionID
        )
    }
}

/// Outcome returned by `Messaging.deliver(...)` (`messaging.deliver`).
public struct MessagingDeliveryResult: Sendable, Equatable {
    public let route: MessagingDeliveryRoute
    public let handlerCount: Int
    public let message: RemoteMessagingMessage

    public init(route: MessagingDeliveryRoute, handlerCount: Int, message: RemoteMessagingMessage) {
        self.route = route
        self.handlerCount = handlerCount
        self.message = message
    }

    package static func fromWire(_ raw: AnySendable) throws -> MessagingDeliveryResult {
        guard let dict = raw.dictionaryValue else {
            throw MessagingError(
                code: .unknown,
                message: "messaging.deliver response from Pyric bridge was not an object."
            )
        }
        let rawRoute = dict["route"]?.stringValue ?? "background"
        let route = MessagingDeliveryRoute(rawValue: rawRoute) ?? .background
        let handlerCount = dict["handlerCount"]?.intValue.map(Int.init) ?? 0
        let payloadVal = dict["payload"] ?? .dictionary([:])
        let message = RemoteMessagingMessage.fromDeliveredPayload(payloadVal, route: route)
            ?? RemoteMessagingMessage(messageID: "", from: "", route: route)
        return MessagingDeliveryResult(route: route, handlerCount: handlerCount, message: message)
    }
}

/// Message envelope accepted by `Messaging.sendBrokerMessage(_:validateOnly:)` (`messaging.send`).
public struct MessagingBrokerMessage: Sendable, Equatable {
    public var token: String?
    public var topic: String?
    public var condition: String?
    public var data: [String: String]?
    public var notification: MessagingNotificationPayload?
    public var android: [String: AnySendable]?
    public var apns: [String: AnySendable]?
    public var webpush: [String: AnySendable]?
    public var fcmOptionsAnalyticsLabel: String?

    public init(
        token: String? = nil,
        topic: String? = nil,
        condition: String? = nil,
        data: [String: String]? = nil,
        notification: MessagingNotificationPayload? = nil,
        android: [String: AnySendable]? = nil,
        apns: [String: AnySendable]? = nil,
        webpush: [String: AnySendable]? = nil,
        fcmOptionsAnalyticsLabel: String? = nil
    ) {
        self.token = token
        self.topic = topic
        self.condition = condition
        self.data = data
        self.notification = notification
        self.android = android
        self.apns = apns
        self.webpush = webpush
        self.fcmOptionsAnalyticsLabel = fcmOptionsAnalyticsLabel
    }

    package func toAnySendable() -> AnySendable {
        var payload: [String: AnySendable] = [:]
        if let token { payload["token"] = .string(token) }
        if let topic { payload["topic"] = .string(topic) }
        if let condition { payload["condition"] = .string(condition) }
        if let data {
            var encodedData: [String: AnySendable] = [:]
            for (k, v) in data {
                encodedData[k] = .string(v)
            }
            payload["data"] = .dictionary(encodedData)
        }
        if let notification {
            let notifWire = notification.toSendWire()
            if !notifWire.isEmpty {
                payload["notification"] = .dictionary(notifWire)
            }
        }
        if let android { payload["android"] = .dictionary(android) }
        if let apns { payload["apns"] = .dictionary(apns) }
        if let webpush { payload["webpush"] = .dictionary(webpush) }
        if let fcmOptionsAnalyticsLabel {
            payload["fcmOptions"] = .dictionary(["analyticsLabel": .string(fcmOptionsAnalyticsLabel)])
        }
        return .dictionary(payload)
    }
}

/// Accepted send receipt returned by `Messaging.sendBrokerMessage(_:validateOnly:)` (`messaging.send`).
public struct AcceptedMessagingSend: Sendable, Equatable {
    public let name: String
    public let messageID: String
    public var messageId: String { messageID }
    public let target: [String: AnySendable]
    public let validateOnly: Bool

    public init(
        name: String,
        messageID: String,
        target: [String: AnySendable] = [:],
        validateOnly: Bool = false
    ) {
        self.name = name
        self.messageID = messageID
        self.target = target
        self.validateOnly = validateOnly
    }

    package static func fromWire(
        _ raw: AnySendable,
        projectID: String? = nil
    ) throws -> AcceptedMessagingSend {
        guard let dict = raw.dictionaryValue else {
            throw MessagingError(
                code: .unknown,
                message: "messaging.send response from Pyric bridge was not an object."
            )
        }
        let rawName = dict["name"]?.stringValue ?? ""
        let name = Self.normalizeReceiptName(rawName, projectID: projectID)
        let messageID = dict["messageId"]?.stringValue ?? ""
        let target = dict["target"]?.dictionaryValue ?? [:]
        let validateOnly = dict["validateOnly"]?.boolValue ?? false
        return AcceptedMessagingSend(
            name: name,
            messageID: messageID,
            target: target,
            validateOnly: validateOnly
        )
    }

    private static func normalizeReceiptName(_ rawName: String, projectID: String?) -> String {
        guard let trimmedProjectID = projectID?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmedProjectID.isEmpty,
              rawName.hasPrefix("projects/") else {
            return rawName
        }
        let afterProjects = rawName.dropFirst("projects/".count)
        guard let messagesRange = afterProjects.range(of: "/messages/") else {
            return rawName
        }
        let suffix = afterProjects[messagesRange.lowerBound...]
        return "projects/\(trimmedProjectID)\(suffix)"
    }
}

/// Cancellable handle returned by `Messaging.onForegroundMessage(_:)` and `Messaging.onBackgroundMessage(_:)`.
public final class MessagingSubscription: Sendable {
    private let onCancel: @Sendable () -> Void
    private let cancelLock = NSLock()
    nonisolated(unsafe) private var isCancelled = false

    package init(onCancel: @escaping @Sendable () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        let shouldInvoke: Bool = {
            cancelLock.lock()
            defer { cancelLock.unlock() }
            if isCancelled {
                return false
            }
            isCancelled = true
            return true
        }()
        if shouldInvoke {
            onCancel()
        }
    }
}
