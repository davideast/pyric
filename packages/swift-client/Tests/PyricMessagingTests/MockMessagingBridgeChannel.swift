import Foundation
import PyricFirestore
import PyricMessaging

/// Deterministic in-memory `WebSocketTransport` emulating `packages/cli/src/serve/worker/host-messaging.ts`
/// for hermetic offline `PyricMessaging` unit tests without network sockets.
final class MockMessagingBridgeChannel: WebSocketTransport, @unchecked Sendable {
    struct RecordedOp: Sendable {
        let method: String
        let params: [String: AnySendable]
    }

    struct RecordedSub: Sendable {
        let subID: String
        let target: String
        let recipientID: String?
    }

    private struct TokenEntry {
        let registrationID: String
        let recipientID: String
        var isActive: Bool
    }

    private let lock = NSLock()
    private var inboundQueue: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var closed = false
    private let messagingEnabled: Bool
    private let getTokenDelayNanoseconds: UInt64

    private var tokenSeq = 0
    private var msgSeq = 0
    private var registrations: [String: String] = [:]
    private var tokenRecords: [String: TokenEntry] = [:]
    private var topics: [String: Set<String>] = [:]
    private var visibilityByRecipient: [String: String] = [:]
    private var activeSubs: [String: RecordedSub] = [:]
    private var deliveredMessageIDsBySub: [String: Set<String>] = [:]

    private(set) var recordedOps: [RecordedOp] = []
    private(set) var recordedSubs: [RecordedSub] = []
    private(set) var recordedUnsubIDs: [String] = []
    private(set) var acknowledgedStages: [(subID: String, messageID: String, stage: String)] = []

    init(messagingEnabled: Bool = true, getTokenDelayNanoseconds: UInt64 = 0) {
        self.messagingEnabled = messagingEnabled
        self.getTokenDelayNanoseconds = getTokenDelayNanoseconds
    }

    func snapshotOps() -> [RecordedOp] {
        lock.lock()
        defer { lock.unlock() }
        return recordedOps
    }

    func snapshotSubs() -> [RecordedSub] {
        lock.lock()
        defer { lock.unlock() }
        return recordedSubs
    }

    func snapshotUnsubIDs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return recordedUnsubIDs
    }

    func snapshotAcknowledgments() -> [(subID: String, messageID: String, stage: String)] {
        lock.lock()
        defer { lock.unlock() }
        return acknowledgedStages
    }

    func send(_ string: String) async throws {
        guard let data = string.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = json["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach":
            enqueueJSON([
                "type": .string("attach-ack"),
                "protocol": .int(1),
                "peerConnected": .bool(true),
                "clientSessionId": .string("mock-messaging-session"),
            ])

        case "ping":
            if let id = json["id"]?.stringValue {
                enqueueJSON(["type": .string("pong"), "id": .string(id)])
            }

        case "worker-sub":
            guard let subID = json["subId"]?.stringValue,
                  let sub = json["sub"]?.dictionaryValue,
                  let target = sub["target"]?.stringValue else {
                return
            }
            let recipientID = sub["recipientId"]?.stringValue
            if !messagingEnabled {
                enqueueJSON([
                    "type": .string("worker-snap"),
                    "subId": .string(subID),
                    "value": .dictionary([
                        "__error": .dictionary([
                            "code": .string("messaging/disabled"),
                            "message": .string("Messaging is disabled on this mock host."),
                        ]),
                    ]),
                ])
                return
            }
            lock.withLock {
                let entry = RecordedSub(subID: subID, target: target, recipientID: recipientID)
                activeSubs[subID] = entry
                recordedSubs.append(entry)
            }

        case "worker-unsub":
            if let subID = json["subId"]?.stringValue {
                lock.withLock {
                    _ = activeSubs.removeValue(forKey: subID)
                    _ = deliveredMessageIDsBySub.removeValue(forKey: subID)
                    recordedUnsubIDs.append(subID)
                }
            }

        case "worker-op":
            guard let id = json["id"]?.stringValue,
                  let op = json["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else {
                return
            }
            lock.withLock {
                recordedOps.append(RecordedOp(method: method, params: op))
            }

            if !messagingEnabled {
                enqueueError(id: id, code: "messaging/disabled", message: "Messaging is disabled on this mock host.")
                return
            }
            if method == "messaging.getToken" && getTokenDelayNanoseconds > 0 {
                let delay = getTokenDelayNanoseconds
                Task {
                    try? await Task.sleep(nanoseconds: delay)
                    self.handleMessagingOp(id: id, method: method, op: op)
                }
                return
            }
            handleMessagingOp(id: id, method: method, op: op)

        default:
            break
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if closed {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            if !inboundQueue.isEmpty {
                let next = inboundQueue.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        _ = closeCode
        _ = reason
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            let snapshot = waiters
            waiters.removeAll()
            return snapshot
        }()
        for waiter in pending {
            waiter.resume(throwing: CancellationError())
        }
    }

    // MARK: - Op Simulation

    private func handleMessagingOp(id: String, method: String, op: [String: AnySendable]) {
        switch method {
        case "messaging.getToken":
            let regID = op["registrationId"]?.stringValue ?? "swreg-port-default"
            let recipID = op["recipientId"]?.stringValue ?? "sandbox-default"
            let token: String = {
                lock.lock()
                defer { lock.unlock() }
                if let existing = registrations[regID] {
                    return existing
                }
                tokenSeq += 1
                let pad = String(repeating: "A", count: 120)
                let minted = "mocktoken\(String(format: "%04d", tokenSeq)):APA91b\(pad)"
                registrations[regID] = minted
                tokenRecords[minted] = TokenEntry(registrationID: regID, recipientID: recipID, isActive: true)
                return minted
            }()
            enqueueSuccess(id: id, value: .dictionary(["token": .string(token)]))

        case "messaging.deleteToken":
            let regID = op["registrationId"]?.stringValue ?? "swreg-port-default"
            lock.lock()
            if let token = registrations.removeValue(forKey: regID) {
                tokenRecords[token]?.isActive = false
            }
            lock.unlock()
            enqueueSuccess(id: id, value: .bool(true))

        case "messaging.subscribeToTopic", "messaging.unsubscribeFromTopic":
            let topic = op["topic"]?.stringValue ?? ""
            let tokens = op["tokens"]?.arrayValue?.compactMap(\.stringValue) ?? []
            var successCount = 0
            var failureCount = 0
            var errors: [AnySendable] = []
            lock.lock()
            var topicSet = topics[topic] ?? []
            for (idx, tok) in tokens.enumerated() {
                if let entry = tokenRecords[tok], !entry.isActive {
                    failureCount += 1
                    errors.append(.dictionary([
                        "index": .int(Int64(idx)),
                        "reason": .string("unregistered-token"),
                    ]))
                } else {
                    if method == "messaging.subscribeToTopic" {
                        topicSet.insert(tok)
                    } else {
                        topicSet.remove(tok)
                    }
                    successCount += 1
                }
            }
            topics[topic] = topicSet
            lock.unlock()
            enqueueSuccess(
                id: id,
                value: .dictionary([
                    "successCount": .int(Int64(successCount)),
                    "failureCount": .int(Int64(failureCount)),
                    "errors": .array(errors),
                ])
            )

        case "messaging.setVisibility":
            let state = op["state"]?.stringValue ?? "hidden"
            let recipID = op["recipientId"]?.stringValue ?? "sandbox-default"
            lock.lock()
            visibilityByRecipient[recipID] = state
            lock.unlock()
            enqueueSuccess(id: id, value: .null)

        case "messaging.deliver":
            let spec = op["spec"]?.dictionaryValue ?? [:]
            let recipID = op["recipientId"]?.stringValue ?? "sandbox-default"
            if let vis = spec["visibilityState"]?.stringValue {
                lock.lock()
                visibilityByRecipient[recipID] = vis
                lock.unlock()
            }
            let payload = buildDeliveredPayload(fromSpec: spec)
            let (route, count, snaps) = routePayload(payload, recipientID: recipID)
            for snap in snaps {
                enqueueJSON(snap)
            }
            enqueueSuccess(
                id: id,
                value: .dictionary([
                    "route": .string(route),
                    "handlerCount": .int(Int64(count)),
                    "payload": .dictionary(payload),
                ])
            )

        case "messaging.send":
            let msg = op["message"]?.dictionaryValue ?? [:]
            let validateOnly = op["validateOnly"]?.boolValue ?? false
            let targetToken = msg["token"]?.stringValue
            let targetTopic = msg["topic"]?.stringValue
            let targetCondition = msg["condition"]?.stringValue

            var targetDesc: [String: AnySendable] = [:]
            var recipients: Set<String> = []

            lock.lock()
            if let targetToken {
                guard let record = tokenRecords[targetToken], record.isActive else {
                    lock.unlock()
                    enqueueError(
                        id: id,
                        code: "NOT_FOUND",
                        message: "Requested entity was not found."
                    )
                    return
                }
                targetDesc = ["kind": .string("token"), "token": .string(targetToken)]
                recipients.insert(record.recipientID)
            } else if let targetTopic {
                targetDesc = ["kind": .string("topic"), "topic": .string(targetTopic)]
                for tok in (topics[targetTopic] ?? []) {
                    if let record = tokenRecords[tok], record.isActive {
                        recipients.insert(record.recipientID)
                    }
                }
            } else if let targetCondition {
                targetDesc = ["kind": .string("condition"), "condition": .string(targetCondition)]
                for (_, record) in tokenRecords where record.isActive {
                    recipients.insert(record.recipientID)
                }
            } else {
                lock.unlock()
                enqueueError(id: id, code: "INVALID_ARGUMENT", message: "Exactly one target must be specified.")
                return
            }
            msgSeq += 1
            let messageID = "mock-msg-\(msgSeq)"
            lock.unlock()

            var snapsToSend: [[String: AnySendable]] = []
            if !validateOnly {
                var payload: [String: AnySendable] = [
                    "from": .string("999999999999"),
                    "messageId": .string(messageID),
                ]
                if let dataObj = msg["data"] {
                    payload["data"] = dataObj
                }
                if let notifObj = msg["notification"]?.dictionaryValue {
                    var deliveredNotif: [String: AnySendable] = [:]
                    if let t = notifObj["title"] { deliveredNotif["title"] = t }
                    if let b = notifObj["body"] { deliveredNotif["body"] = b }
                    if let img = notifObj["imageUrl"] ?? notifObj["image"] { deliveredNotif["image"] = img }
                    if !deliveredNotif.isEmpty {
                        payload["notification"] = .dictionary(deliveredNotif)
                    }
                }
                for recip in recipients {
                    let (_, _, snaps) = routePayload(payload, recipientID: recip)
                    snapsToSend.append(contentsOf: snaps)
                }
            }
            for snap in snapsToSend {
                enqueueJSON(snap)
            }
            enqueueSuccess(
                id: id,
                value: .dictionary([
                    "name": .string("projects/mock-project/messages/\(messageID)"),
                    "messageId": .string(messageID),
                    "target": .dictionary(targetDesc),
                    "validateOnly": .bool(validateOnly),
                ])
            )

        case "messaging.acknowledge":
            let subID = op["subId"]?.stringValue ?? ""
            let messageID = op["messageId"]?.stringValue ?? ""
            let stage = op["stage"]?.stringValue ?? ""
            let matched: Bool = {
                lock.lock()
                defer { lock.unlock() }
                guard deliveredMessageIDsBySub[subID]?.contains(messageID) == true else {
                    return false
                }
                acknowledgedStages.append((subID: subID, messageID: messageID, stage: stage))
                return true
            }()
            if matched {
                enqueueSuccess(id: id, value: .null)
            } else {
                enqueueError(
                    id: id,
                    code: "unknown",
                    message: "Messaging acknowledgment has no matching delivery on this subscription."
                )
            }

        default:
            enqueueError(id: id, code: "INVALID_ARGUMENT", message: "Unsupported mock op: \(method)")
        }
    }

    private func buildDeliveredPayload(fromSpec spec: [String: AnySendable]) -> [String: AnySendable] {
        lock.lock()
        msgSeq += 1
        let fallbackID = "deliver-msg-\(msgSeq)"
        lock.unlock()

        var payload: [String: AnySendable] = [
            "from": spec["from"] ?? .string("999999999999"),
            "messageId": spec["messageId"] ?? .string(fallbackID),
        ]
        if let data = spec["data"] {
            payload["data"] = data
        }
        if let notif = spec["notification"] {
            payload["notification"] = notif
        }
        return payload
    }

    private func routePayload(
        _ payload: [String: AnySendable],
        recipientID: String
    ) -> (route: String, count: Int, snaps: [[String: AnySendable]]) {
        lock.lock()
        defer { lock.unlock() }
        let isVisible = visibilityByRecipient[recipientID] == "visible"
        let route = isVisible ? "foreground" : "background"
        let wantedTarget = isVisible ? "messaging.foreground" : "messaging.background"
        let msgID = payload["messageId"]?.stringValue ?? ""

        var snaps: [[String: AnySendable]] = []
        for sub in activeSubs.values {
            let subRecip = sub.recipientID ?? "sandbox-default"
            guard sub.target == wantedTarget && subRecip == recipientID else {
                continue
            }
            var seen = deliveredMessageIDsBySub[sub.subID] ?? []
            seen.insert(msgID)
            deliveredMessageIDsBySub[sub.subID] = seen
            snaps.append([
                "type": .string("worker-snap"),
                "subId": .string(sub.subID),
                "value": .dictionary(payload),
            ])
        }
        return (route, snaps.count, snaps)
    }

    private func enqueueSuccess(id: String, value: AnySendable) {
        enqueueJSON([
            "type": .string("worker-res"),
            "id": .string(id),
            "ok": .bool(true),
            "value": value,
        ])
    }

    private func enqueueError(id: String, code: String, message: String) {
        enqueueJSON([
            "type": .string("worker-res"),
            "id": .string(id),
            "ok": .bool(false),
            "error": .dictionary([
                "code": .string(code),
                "message": .string(message),
            ]),
        ])
    }

    private func enqueueJSON(_ dict: [String: AnySendable]) {
        guard let data = try? JSONEncoder().encode(AnySendable.dictionary(dict)),
              let raw = String(data: data, encoding: .utf8) else {
            return
        }
        let waiter: CheckedContinuation<String, any Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !waiters.isEmpty {
                return waiters.removeFirst()
            }
            inboundQueue.append(raw)
            return nil
        }()
        waiter?.resume(returning: raw)
    }
}
