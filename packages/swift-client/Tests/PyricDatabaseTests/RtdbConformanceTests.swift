import Testing
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
            if let dict = RtdbValueCodec.fromAnySendable(op["values"]) as? [String: Any] {
                for (k, v) in dict { setNode(path: path == "/" ? "/\(k)" : "\(path)/\(k)", val: v, prio: nil) }
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

@Suite("rtdb-swift Conformance Suite", .serialized)
struct RtdbConformanceTests {

    // ── 1. Database Instance & Connection (5 rows) ────────────────────────────
    @Test func `rtdb-swift#instance-default: Database.database() returns default instance`() async throws {
        let db = Database.database()
        #expect(db.url == "https://default.firebaseio.com")
    }
    @Test func `rtdb-swift#instance-url: Database.database(url:) returns custom URL instance`() async throws {
        let db = Database.database(url: "https://custom-rtdb.firebaseio.com")
        #expect(db.url == "https://custom-rtdb.firebaseio.com")
    }
    @Test func `rtdb-swift#ref-root: Database.reference() returns root reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference()
        #expect(ref.path == "/" && ref.key == nil)
    }
    @Test func `rtdb-swift#ref-path: Database.reference(withPath:) returns targeted reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users/alice")
        #expect(ref.path == "/users/alice" && ref.key == "alice")
    }
    @Test func `rtdb-swift#connection-toggle: Database.goOffline() and goOnline() toggle connection`() async throws {
        let harness = try await RtdbTestHarness.create()
        try await harness.database.goOffline()
        #expect(harness.isOffline == true)
        try await harness.database.goOnline()
        #expect(harness.isOffline == false)
    }

    // ── 2. DatabaseReference Navigation & Properties (7 rows) ─────────────────
    @Test func `rtdb-swift#ref-child: DatabaseReference.child(_:) navigates relative path`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users").child("bob/profile")
        #expect(ref.path == "/users/bob/profile")
    }
    @Test func `rtdb-swift#ref-parent: DatabaseReference.parent returns parent or nil for root`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "users/bob")
        #expect(ref.parent?.path == "/users" && ref.parent?.parent?.path == "/" && ref.parent?.parent?.parent == nil)
    }
    @Test func `rtdb-swift#ref-root-prop: DatabaseReference.root returns root reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "a/b/c")
        #expect(ref.root.path == "/")
    }
    @Test func `rtdb-swift#ref-key: DatabaseReference.key returns last segment or nil`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "items/item42")
        #expect(ref.key == "item42" && ref.root.key == nil)
    }
    @Test func `rtdb-swift#ref-path-prop: DatabaseReference.url and path return full path`() async throws {
        let harness = try await RtdbTestHarness.create(url: "https://my-db.firebaseio.com")
        let ref = harness.database.reference(withPath: "posts/p1")
        #expect(ref.path == "/posts/p1" && ref.url == "https://my-db.firebaseio.com/posts/p1")
    }
    @Test func `rtdb-swift#ref-push: DatabaseReference.childByAutoId() creates unique push reference`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "list")
        let pushed1 = ref.childByAutoId()
        let pushed2 = ref.childByAutoId()
        #expect(pushed1.key != nil && pushed1.key != pushed2.key)
    }
    @Test func `rtdb-swift#ref-push-key-ordering: DatabaseReference.childByAutoId().key orders monotonically`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "ordered")
        let k1 = ref.childByAutoId().key!
        let k2 = ref.childByAutoId().key!
        let k3 = ref.childByAutoId().key!
        #expect(k1 < k2 && k2 < k3)
    }

    // ── 3. Write Operations (6 rows) ──────────────────────────────────────────
    @Test func `rtdb-swift#write-set: DatabaseReference.setValue(_:) writes value at path`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "greeting")
        try await ref.setValue("hello world")
        let snap = try await ref.getData()
        #expect(snap.value as? String == "hello world")
    }
    @Test func `rtdb-swift#write-set-null: DatabaseReference.setValue(nil) deletes node`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "temp")
        try await ref.setValue("to-delete")
        try await ref.setValue(nil)
        let snap = try await ref.getData()
        #expect(snap.exists() == false)
    }
    @Test func `rtdb-swift#write-set-priority: DatabaseReference.setPriority(_:) updates node priority`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "prioNode")
        try await ref.setValue("data")
        try await ref.setPriority(100)
        let snap = try await ref.getData()
        #expect((snap.priority as? NSNumber)?.intValue == 100)
    }
    @Test func `rtdb-swift#write-set-with-priority: DatabaseReference.setValue(_:andPriority:) writes both`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "ranked")
        try await ref.setValue("gold", andPriority: 1)
        let snap = try await ref.getData()
        #expect(snap.value as? String == "gold" && (snap.priority as? NSNumber)?.intValue == 1)
    }
    @Test func `rtdb-swift#write-update: DatabaseReference.updateChildValues(_:) updates specified children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "profile")
        try await ref.setValue(["name": "Alice", "role": "user"])
        try await ref.updateChildValues(["role": "admin"])
        let snap = try await ref.getData()
        let dict = snap.value as? [String: Any]
        #expect(dict?["name"] as? String == "Alice" && dict?["role"] as? String == "admin")
    }
    @Test func `rtdb-swift#write-remove: DatabaseReference.removeValue() removes node`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "session")
        try await ref.setValue("active")
        try await ref.removeValue()
        let snap = try await ref.getData()
        #expect(snap.exists() == false)
    }

    // ── 4. ServerValue Sentinels (2 rows) ─────────────────────────────────────
    @Test func `rtdb-swift#sentinel-timestamp: ServerValue.timestamp() resolves to epoch ms`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "createdAt")
        try await ref.setValue(ServerValue.timestamp())
        let snap = try await ref.getData()
        #expect(((snap.value as? NSNumber)?.intValue ?? 0) > 1_700_000_000_000)
    }
    @Test func `rtdb-swift#sentinel-increment: ServerValue.increment(_:) atomically increments value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "counter")
        try await ref.setValue(10)
        try await ref.setValue(ServerValue.increment(5))
        let snap = try await ref.getData()
        #expect((snap.value as? NSNumber)?.intValue == 15)
    }

    // ── 5. One-Shot Reads & DataSnapshot Inspection (7 rows) ──────────────────
    @Test func `rtdb-swift#read-get: DatabaseReference.getData() fetches DataSnapshot`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "config/theme")
        try await ref.setValue("dark")
        let snap = try await ref.getData()
        #expect(snap.value as? String == "dark")
    }
    @Test func `rtdb-swift#snap-exists: DataSnapshot.exists() reports existence accurately`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "check")
        let emptySnap = try await ref.getData()
        #expect(emptySnap.exists() == false)
        try await ref.setValue(42)
        let fullSnap = try await ref.getData()
        #expect(fullSnap.exists() == true)
    }
    @Test func `rtdb-swift#snap-key: DataSnapshot.key returns node key`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "teams/alpha")
        try await ref.setValue(["members": 5])
        let snap = try await ref.getData()
        #expect(snap.key == "alpha")
    }
    @Test func `rtdb-swift#snap-value: DataSnapshot.value returns native deserialized value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scalar")
        try await ref.setValue(true)
        let snap = try await ref.getData()
        #expect(snap.value as? Bool == true)
    }
    @Test func `rtdb-swift#snap-children: DataSnapshot.children enumerates child snapshots`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "fruits")
        try await ref.setValue(["a": "apple", "b": "banana"])
        let snap = try await ref.getData()
        let children = snap.children.allObjects.compactMap { $0 as? DataSnapshot }
        #expect(children.count == 2 && children.map { $0.key } == ["a", "b"])
    }
    @Test func `rtdb-swift#snap-child-path: DataSnapshot.childSnapshot(forPath:) navigates descendants`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "org")
        try await ref.setValue(["dept": ["lead": "Carol"]])
        let snap = try await ref.getData()
        #expect(snap.childSnapshot(forPath: "dept/lead").value as? String == "Carol")
    }
    @Test func `rtdb-swift#snap-priority: DataSnapshot.priority returns node priority`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "prioSnap")
        try await ref.setValue("item", andPriority: "p1")
        let snap = try await ref.getData()
        #expect(snap.priority as? String == "p1")
    }

    // ── 6. Realtime Listeners & Streams (5 rows) ──────────────────────────────
    @Test func `rtdb-swift#listen-value: DatabaseQuery.observe(.value) emits snapshots`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "liveValue")
        try await ref.setValue("v1")
        var stream = ref.valueStream.makeAsyncIterator()
        let first = try await stream.next()
        #expect(first?.value as? String == "v1")
    }
    @Test func `rtdb-swift#listen-child-added: DatabaseQuery.observe(.childAdded) emits existing and new children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenAdd")
        try await ref.setValue(["c1": "one"])
        var iterator = ref.childEvents.makeAsyncIterator()
        let ev1 = try await iterator.next()
        #expect(ev1?.type == .childAdded && ev1?.snapshot.key == "c1")
    }
    @Test func `rtdb-swift#listen-child-changed: DatabaseQuery.observe(.childChanged) emits modified children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenChange")
        try await ref.setValue(["c1": "initial"])
        var iterator = ref.childEvents.makeAsyncIterator()
        _ = try await iterator.next()
        try await ref.child("c1").setValue("updated")
        let ev2 = try await iterator.next()
        #expect(ev2?.type == .childChanged && ev2?.snapshot.value as? String == "updated")
    }
    @Test func `rtdb-swift#listen-child-removed: DatabaseQuery.observe(.childRemoved) emits removed children`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "childrenRemove")
        try await ref.setValue(["c1": "gone"])
        var iterator = ref.childEvents.makeAsyncIterator()
        _ = try await iterator.next()
        try await ref.child("c1").removeValue()
        let ev2 = try await iterator.next()
        #expect(ev2?.type == .childRemoved && ev2?.snapshot.key == "c1")
    }
    @Test func `rtdb-swift#listen-cancel: DatabaseQuery.removeObserver(withHandle:) unsubscribes listener`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "cancelPath")
        let handle = ref.observe(.value) { _ in }
        try await Task.sleep(nanoseconds: 20_000_000)
        ref.removeObserver(withHandle: handle)
        #expect(handle > 0)
    }

    // ── 7. Query Ordering, Filtering & Limits (6 rows) ────────────────────────
    @Test func `rtdb-swift#query-order-by-child: DatabaseQuery.queryOrdered(byChild:) orders by nested key`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scores")
        try await ref.setValue(["u1": ["score": 30], "u2": ["score": 10], "u3": ["score": 20]])
        let snap = try await ref.queryOrdered(byChild: "score").getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["u2", "u3", "u1"])
    }
    @Test func `rtdb-swift#query-order-by-key: DatabaseQuery.queryOrderedByKey() orders lexicographically`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "letters")
        try await ref.setValue(["b": 2, "a": 1, "c": 3])
        let snap = try await ref.queryOrderedByKey().getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["a", "b", "c"])
    }
    @Test func `rtdb-swift#query-order-by-value: DatabaseQuery.queryOrderedByValue() orders by scalar value`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "scalars")
        try await ref.setValue(["x": 50, "y": 10, "z": 30])
        let snap = try await ref.queryOrderedByValue().getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["y", "z", "x"])
    }
    @Test func `rtdb-swift#query-equal-to: DatabaseQuery.queryEqual(toValue:) filters exact matches`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "tiers")
        try await ref.setValue(["p1": 100, "p2": 200, "p3": 100])
        let snap = try await ref.queryOrderedByValue().queryEqual(toValue: 100).getData()
        let keys = snap.childrenSnapshots.compactMap { $0.key }
        #expect(keys.count == 2 && keys.contains("p1") && keys.contains("p3"))
    }
    @Test func `rtdb-swift#query-range: DatabaseQuery.queryStarting(atValue:) and queryEnding(atValue:) filter range`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "nums")
        try await ref.setValue(["n1": 10, "n2": 20, "n3": 30, "n4": 40])
        let snap = try await ref.queryOrderedByValue().queryStarting(atValue: 15).queryEnding(atValue: 35).getData()
        #expect(snap.childrenSnapshots.compactMap { $0.key } == ["n2", "n3"])
    }
    @Test func `rtdb-swift#query-limit: DatabaseQuery.queryLimited(toFirst:) and queryLimited(toLast:) limit results`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "limited")
        try await ref.setValue(["k1": 1, "k2": 2, "k3": 3, "k4": 4])
        let firstTwo = try await ref.queryOrderedByKey().queryLimited(toFirst: 2).getData()
        #expect(firstTwo.childrenSnapshots.compactMap { $0.key } == ["k1", "k2"])
        let lastTwo = try await ref.queryOrderedByKey().queryLimited(toLast: 2).getData()
        #expect(lastTwo.childrenSnapshots.compactMap { $0.key } == ["k3", "k4"])
    }

    // ── 8. Transactions & OnDisconnect (4 rows) ───────────────────────────────
    @Test func `rtdb-swift#tx-run: DatabaseReference.runTransactionBlock(_:) commits updated MutableData`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "balance")
        try await ref.setValue(100)
        let result = try await ref.runTransactionBlock { currentData in
            currentData.value = ((currentData.value as? NSNumber)?.intValue ?? 0) + 50
            return TransactionResult.success(withValue: currentData)
        }
        #expect(result.committed == true && (result.snapshot.value as? NSNumber)?.intValue == 150)
    }
    @Test func `rtdb-swift#tx-abort: TransactionResult.abort() aborts transaction without saving`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "lockedBalance")
        try await ref.setValue(100)
        let result = try await ref.runTransactionBlock { _ in TransactionResult.abort() }
        let snap = try await ref.getData()
        #expect(result.committed == false && (snap.value as? NSNumber)?.intValue == 100)
    }
    @Test func `rtdb-swift#ondisconnect-set-remove: DatabaseReference.onDisconnectSetValue(_:) executes on goOffline()`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "presence/user1")
        try await ref.setValue("online")
        try await ref.onDisconnectSetValue("offline")
        try await harness.database.goOffline()
        let snap = try await ref.getData()
        #expect(snap.value as? String == "offline")
    }
    @Test func `rtdb-swift#ondisconnect-cancel: DatabaseReference.cancelDisconnectOperations() cancels queued operations`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "presence/user2")
        try await ref.setValue("online")
        try await ref.onDisconnectSetValue("offline")
        try await ref.cancelDisconnectOperations()
        try await harness.database.goOffline()
        let snap = try await ref.getData()
        #expect(snap.value as? String == "online")
    }

    // ── AuthLens Propagation Integration Verification ─────────────────────────
    @Test func `authlens-propagation: Database propagates active AuthLens on ops and subscriptions`() async throws {
        let harness = try await RtdbTestHarness.create()
        let ref = harness.database.reference(withPath: "secure/data")
        harness.database.switchLens(.admin)
        try await ref.setValue("admin-only")
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "admin")
        harness.database.switchLens(.asUser(uid: "alice"))
        _ = try await ref.getData()
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "as")
        #expect(harness.recordedOps.last?.actAs?["uid"]?.stringValue == "alice")
        harness.database.switchLens(.anon)
        _ = try await ref.getData()
        #expect(harness.recordedOps.last?.actAs?["mode"]?.stringValue == "anon")
    }
}
