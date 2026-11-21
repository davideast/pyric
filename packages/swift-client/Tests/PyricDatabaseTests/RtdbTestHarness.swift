import Foundation
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

/// In-memory RTDB test transport implementing WebSocketTransport for hermetic conformance testing.
final class RtdbTestHarness: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var tree: [String: (value: Any, priority: Any?)] = [:]
    private var activeSubs: [String: (path: String, query: AnySendable?, actAs: AnySendable?)] = [:]
    private var onDisconnectQueue: [(path: String, kind: String, val: Any?, prio: Any?)] = []
    public private(set) var isOffline = false
    public private(set) var recordedOps: [(method: String, actAs: AnySendable?)] = []
    public private(set) var recordedSubs: [(subId: String, actAs: AnySendable?)] = []
    public private(set) var database: Database!

    static func create(url: String = "https://default.firebaseio.com") async throws -> RtdbTestHarness {
        let harness = RtdbTestHarness()
        let client = PyricBridgeClient(channel: harness)
        let app = FirebaseApp(name: "test-\(UUID().uuidString)")
        harness.database = Database(app: app, url: url, bridgeClient: client)
        return harness
    }
    func send(_ string: String) async throws {
        for (msg, cont) in handleSendSync(string) { cont.resume(returning: msg) }
    }
    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if !incomingQueue.isEmpty {
                let msg = incomingQueue.removeFirst()
                lock.unlock()
                cont.resume(returning: msg)
            } else {
                receiveContinuations.append(cont)
                lock.unlock()
            }
        }
    }
    func close(closeCode: Int = 1000, reason: String? = nil) async {}
    private func enqueue(_ dict: [String: Any]) -> (String, CheckedContinuation<String, Error>)? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return nil }
        if !receiveContinuations.isEmpty { return (str, receiveContinuations.removeFirst()) }
        incomingQueue.append(str)
        return nil
    }
    private func handleSendSync(_ raw: String) -> [(String, CheckedContinuation<String, Error>)] {
        lock.lock()
        defer { lock.unlock() }
        var toResume: [(String, CheckedContinuation<String, Error>)] = []
        guard let data = raw.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = json.dictionaryValue,
              let type = dict["type"]?.stringValue else { return [] }
        if type == "attach" {
            if let r = enqueue(["type": "attach-ack", "protocol": 1, "peerConnected": true]) { toResume.append(r) }
        } else if type == "worker-op" {
            let id = dict["id"]?.stringValue ?? ""
            let op = dict["op"]?.dictionaryValue ?? [:]
            let method = op["method"]?.stringValue ?? ""
            recordedOps.append((method: method, actAs: op["actAs"]))
            let resValue = executeOp(method: method, op: op, toResume: &toResume)
            if let r = enqueue(["type": "worker-res", "id": id, "ok": true, "value": resValue ?? NSNull()]) { toResume.append(r) }
        } else if type == "worker-sub" {
            let subId = dict["subId"]?.stringValue ?? ""
            let sub = dict["sub"]?.dictionaryValue ?? [:]
            let target = sub["target"]?.dictionaryValue ?? [:]
            let path = normalize(target["path"]?.stringValue ?? "/")
            let query = target["query"]
            recordedSubs.append((subId: subId, actAs: sub["actAs"]))
            activeSubs[subId] = (path: path, query: query, actAs: sub["actAs"])
            let snap = buildSnapWire(path: path, query: query)
            if let r = enqueue(["type": "worker-snap", "subId": subId, "value": snap]) { toResume.append(r) }
        } else if type == "worker-unsub" {
            if let subId = dict["subId"]?.stringValue { activeSubs.removeValue(forKey: subId) }
        }
        return toResume
    }
    private func normalize(_ path: String) -> String {
        let p = path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        return p.isEmpty ? "/" : "/" + p.joined(separator: "/")
    }
    private func resolveSentinels(_ val: Any, current: Any?) -> Any {
        if let dict = val as? [String: Any] {
            if let sv = dict[".sv"] as? String, sv == "timestamp" { return Int(Date().timeIntervalSince1970 * 1000) }
            if let svDict = dict[".sv"] as? [String: Any], let inc = svDict["increment"] {
                return ((current as? NSNumber)?.doubleValue ?? 0) + ((inc as? NSNumber)?.doubleValue ?? 0)
            }
            var out: [String: Any] = [:]
            let curDict = current as? [String: Any]
            for (k, v) in dict { out[k] = resolveSentinels(v, current: curDict?[k]) }
            return out
        }
        return val
    }

    private func setNode(path: String, val: Any?, prio: Any?) {
        let norm = normalize(path)
        let prefix = norm == "/" ? "/" : norm + "/"
        if val == nil || val is NSNull {
            tree.removeValue(forKey: norm)
            for k in tree.keys where k.hasPrefix(prefix) { tree.removeValue(forKey: k) }
            return
        }
        let cur = getNodeValue(path: norm).value
        let resolved = resolveSentinels(val!, current: cur)
        if let dict = resolved as? [String: Any] {
            tree.removeValue(forKey: norm)
            for k in tree.keys where k.hasPrefix(prefix) { tree.removeValue(forKey: k) }
            for (k, childV) in dict {
                let cPath = norm == "/" ? "/\(k)" : "\(norm)/\(k)"
                setNode(path: cPath, val: childV, prio: nil)
            }
        } else {
            for k in tree.keys where k.hasPrefix(prefix) { tree.removeValue(forKey: k) }
            let existingPrio = prio ?? tree[norm]?.priority
            tree[norm] = (value: resolved, priority: existingPrio)
        }
    }

    private func getNodeValue(path: String) -> (value: Any?, priority: Any?) {
        let norm = normalize(path)
        if let direct = tree[norm] { return (direct.value, direct.priority) }
        let prefix = norm == "/" ? "/" : norm + "/"
        var directChildrenKeys = Set<String>()
        for k in tree.keys where k.hasPrefix(prefix) {
            let rem = String(k.dropFirst(prefix.count))
            if let firstSeg = rem.split(separator: "/").first { directChildrenKeys.insert(String(firstSeg)) }
        }
        if directChildrenKeys.isEmpty { return (nil, nil) }
        var resultDict: [String: Any] = [:]
        for childKey in directChildrenKeys {
            let childPath = norm == "/" ? "/\(childKey)" : "\(norm)/\(childKey)"
            if let childVal = getNodeValue(path: childPath).value { resultDict[childKey] = childVal }
        }
        return (resultDict, nil)
    }

    private func buildSnapWire(path: String, query: AnySendable?) -> [String: Any] {
        let norm = normalize(path)
        let key = norm == "/" ? NSNull() : (norm.split(separator: "/").last.map(String.init) ?? NSNull()) as Any
        let node = getNodeValue(path: norm)
        var entries: [[String: Any]] = []
        if let dict = node.value as? [String: Any] {
            var pairs = dict.map { (k: $0.key, v: $0.value, p: tree[norm == "/" ? "/\($0.key)" : "\(norm)/\($0.key)"]?.priority) }
            if let qDict = query?.dictionaryValue {
                if let orderBy = qDict["orderBy"]?.dictionaryValue, let kind = orderBy["kind"]?.stringValue {
                    if kind == "key" { pairs.sort { $0.k < $1.k } }
                    else if kind == "value" { pairs.sort { (($0.v as? NSNumber)?.doubleValue ?? 0) < (($1.v as? NSNumber)?.doubleValue ?? 0) } }
                    else if kind == "child", let childKey = orderBy["path"]?.stringValue {
                        pairs.sort {
                            let a = (($0.v as? [String: Any])?[childKey] as? NSNumber)?.doubleValue ?? 0
                            let b = (($1.v as? [String: Any])?[childKey] as? NSNumber)?.doubleValue ?? 0
                            return a < b
                        }
                    }
                }
                if let bounds = qDict["bounds"]?.arrayValue {
                    for b in bounds {
                        guard let bDict = b.dictionaryValue, let bKind = bDict["kind"]?.stringValue else { continue }
                        let bVal = RtdbValueCodec.fromAnySendable(bDict["value"])
                        let bNum = (bVal as? NSNumber)?.doubleValue
                        let bStr = bVal as? String
                        let orderKind = qDict["orderBy"]?.dictionaryValue?["kind"]?.stringValue
                        let childKey = qDict["orderBy"]?.dictionaryValue?["path"]?.stringValue
                        pairs = pairs.filter { item in
                            let targetVal: Any? = (orderKind == "key") ? item.k : (orderKind == "child" && childKey != nil ? (item.v as? [String: Any])?[childKey!] : item.v)
                            if let tNum = (targetVal as? NSNumber)?.doubleValue, let bNum {
                                if bKind == "equalTo" { return tNum == bNum }
                                if bKind == "startAt" { return tNum >= bNum }
                                if bKind == "endAt" { return tNum <= bNum }
                            } else if let tStr = targetVal as? String, let bStr {
                                if bKind == "equalTo" { return tStr == bStr }
                                if bKind == "startAt" { return tStr >= bStr }
                                if bKind == "endAt" { return tStr <= bStr }
                            }
                            return true
                        }
                    }
                }
                if let limitDict = qDict["limit"]?.dictionaryValue,
                   let lKind = limitDict["kind"]?.stringValue,
                   let n = limitDict["n"]?.intValue {
                    if lKind == "limitToFirst" { pairs = Array(pairs.prefix(Int(n))) }
                    else if lKind == "limitToLast" { pairs = Array(pairs.suffix(Int(n))) }
                }
            } else {
                pairs.sort { $0.k < $1.k }
            }
            for item in pairs { entries.append(["key": item.k, "value": item.v, "priority": item.p ?? NSNull()]) }
        }
        return [
            "key": key,
            "exists": node.value != nil,
            "value": node.value ?? NSNull(),
            "priority": node.priority ?? NSNull(),
            "entries": entries
        ]
    }

    private func notifySubscribers(toResume: inout [(String, CheckedContinuation<String, Error>)]) {
        for (subId, sub) in activeSubs {
            let snap = buildSnapWire(path: sub.path, query: sub.query)
            if let r = enqueue(["type": "worker-snap", "subId": subId, "value": snap]) { toResume.append(r) }
        }
    }

    private func executeOp(method: String, op: [String: AnySendable], toResume: inout [(String, CheckedContinuation<String, Error>)]) -> Any? {
        let path = normalize(op["path"]?.stringValue ?? "/")
        switch method {
        case "rtdb.get": return buildSnapWire(path: path, query: op["query"])
        case "rtdb.set":
            setNode(path: path, val: RtdbValueCodec.fromAnySendable(op["value"]), prio: nil)
            notifySubscribers(toResume: &toResume)
        case "rtdb.setPriority":
            setNode(path: path, val: getNodeValue(path: path).value, prio: RtdbValueCodec.fromAnySendable(op["priority"]))
            notifySubscribers(toResume: &toResume)
        case "rtdb.setWithPriority":
            setNode(path: path, val: RtdbValueCodec.fromAnySendable(op["value"]), prio: RtdbValueCodec.fromAnySendable(op["priority"]))
            notifySubscribers(toResume: &toResume)
        case "rtdb.update":
            if let valuesDict = op["values"]?.dictionaryValue {
                for (k, v) in valuesDict {
                    setNode(path: path == "/" ? "/\(k)" : "\(path)/\(k)", val: RtdbValueCodec.fromAnySendable(v), prio: nil)
                }
            }
            notifySubscribers(toResume: &toResume)
        case "rtdb.remove":
            setNode(path: path, val: nil, prio: nil)
            notifySubscribers(toResume: &toResume)
        case "rtdb.transactionCommit":
            setNode(path: path, val: RtdbValueCodec.fromAnySendable(op["value"]), prio: nil)
            notifySubscribers(toResume: &toResume)
            return ["retry": false, "committed": true, "snapshot": buildSnapWire(path: path, query: nil)]
        case "rtdb.onDisconnectSet":
            onDisconnectQueue.append((path: path, kind: "set", val: RtdbValueCodec.fromAnySendable(op["value"]), prio: RtdbValueCodec.fromAnySendable(op["priority"])))
        case "rtdb.onDisconnectRemove":
            onDisconnectQueue.append((path: path, kind: "remove", val: nil, prio: nil))
        case "rtdb.onDisconnectCancel":
            onDisconnectQueue.removeAll { $0.path == path }
        case "rtdb.goOffline":
            isOffline = true
            for item in onDisconnectQueue {
                if item.kind == "set" { setNode(path: item.path, val: item.val, prio: item.prio) }
                else if item.kind == "remove" { setNode(path: item.path, val: nil, prio: nil) }
            }
            onDisconnectQueue.removeAll()
            notifySubscribers(toResume: &toResume)
        case "rtdb.goOnline":
            isOffline = false
        default: break
        }
        return nil
    }
}
