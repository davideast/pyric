import Foundation
import Testing
@testable import PyricDatabase
@testable import PyricFirestore
import FirebaseAuth

extension LiveHostConformanceTests {

    // -- Hermetic Validation & Codec Parity Checks (Linux + macOS) --

    @Test("DatabaseInstanceResolver canonicalizes shard URLs and project default instances")
    func instanceResolverAndCanonicalKeyParity() {
        #expect(
            DatabaseInstanceResolver.resolveInstanceName(
                from: "https://demo-swift-live-default-rtdb.firebaseio.com",
                projectID: "demo-swift-live"
            ) == nil
        )
        #expect(
            DatabaseInstanceResolver.resolveInstanceName(
                from: "https://demo-swift-live.firebaseio.com",
                projectID: "demo-swift-live"
            ) == nil
        )
        #expect(
            DatabaseInstanceResolver.canonicalInstanceKey(
                from: "https://demo-swift-live-default-rtdb.firebaseio.com/",
                projectID: "demo-swift-live"
            ) == "instance:<default>"
        )
        #expect(
            DatabaseInstanceResolver.canonicalInstanceKey(
                from: "https://SHARD-04.europe-west1.firebasedatabase.app/"
            ) == "instance:shard-04"
        )

        let app = FirebaseApp(name: "rtdb-canonical-\(UUID().uuidString)")
        defer { Database.reset() }
        let s1 = Database.database(app: app, url: "https://shard-04.firebaseio.com")
        let s2 = Database.database(app: app, url: "https://SHARD-04.firebaseio.com/")
        let s3 = Database.database(app: app, url: "https://shard-04.europe-west1.firebasedatabase.app")
        let s4 = Database.database(app: app, url: "http://127.0.0.1:9000/?ns=shard-04")
        #expect(s1 === s2)
        #expect(s1 === s3)
        #expect(s1 === s4)
    }

    @Test("Database.reference(fromURL:) validates scheme, host, namespace, fragments, and path tokens")
    func referenceFromURLValidationAndRouting() throws {
        let app = FirebaseApp(name: "rtdb-refurl-\(UUID().uuidString)")
        defer { Database.reset() }

        let shard00 = Database.database(app: app, url: "https://shard-00.firebaseio.com/")
        #expect(shard00.url == "https://shard-00.firebaseio.com")

        let roomRef = shard00.reference(fromURL: "https://shard-00.firebaseio.com/rooms/room%20alpha")
        #expect(roomRef.path == "/rooms/room alpha")
        #expect(roomRef.key == "room alpha")
        #expect(roomRef.url == "https://shard-00.firebaseio.com/rooms/room%20alpha")
        #expect(roomRef.database === shard00)

        let infoRef = shard00.reference(fromURL: "https://shard-00.firebaseio.com/.info/connected")
        #expect(infoRef.path == "/.info/connected")

        shard00.useEmulator(withHost: "127.0.0.1", port: 9150)
        let emulatedRef = shard00.reference(fromURL: "http://127.0.0.1:9150/rooms/r2?ns=shard-00")
        #expect(emulatedRef.path == "/rooms/r2")
        #expect(emulatedRef.database === shard00)

        #expect(throws: DatabaseURLValidationError.emptyURL) {
            _ = try shard00.validatedReference(fromURL: "   ")
        }
        #expect(throws: DatabaseURLValidationError.malformedURL("/rooms/r1")) {
            _ = try shard00.validatedReference(fromURL: "/rooms/r1")
        }
        #expect(throws: DatabaseURLValidationError.unsupportedScheme("ftp")) {
            _ = try shard00.validatedReference(fromURL: "ftp://shard-00.firebaseio.com/rooms/r1")
        }
        #expect(throws: DatabaseURLValidationError.fragmentNotAllowed("https://shard-00.firebaseio.com/rooms/r1#frag")) {
            _ = try shard00.validatedReference(fromURL: "https://shard-00.firebaseio.com/rooms/r1#frag")
        }
        #expect(throws: DatabaseURLValidationError.invalidPathSegment("bad$key")) {
            _ = try shard00.validatedReference(fromURL: "https://shard-00.firebaseio.com/rooms/bad$key")
        }
        #expect(
            throws: DatabaseURLValidationError.hostMismatch(
                found: "shard-01.firebaseio.com",
                expected: "shard-00.firebaseio.com"
            )
        ) {
            _ = try shard00.validatedReference(fromURL: "https://shard-01.firebaseio.com/rooms/r1")
        }
        #expect(
            throws: DatabaseURLValidationError.hostMismatch(
                found: "127.0.0.1:9150",
                expected: "shard-00.firebaseio.com"
            )
        ) {
            _ = try shard00.validatedReference(fromURL: "http://127.0.0.1:9150/rooms/r1?ns=shard-01")
        }
    }

    @Test("RtdbValueCodec preserves integer 0/1 vs Bool across NSNumber bridging")
    func rtdbValueCodecNumericBooleanFidelity() {
        #expect(RtdbValueCodec.toAnySendable(NSNumber(value: 1)) == .int(1))
        #expect(RtdbValueCodec.toAnySendable(NSNumber(value: 0)) == .int(0))
        #expect(RtdbValueCodec.toAnySendable(NSNumber(value: true)) == .bool(true))
        #expect(RtdbValueCodec.toAnySendable(NSNumber(value: false)) == .bool(false))
        #expect(RtdbValueCodec.toAnySendable(NSNumber(value: 3.5)) == .double(3.5))

        let intInc = RtdbValueCodec.toAnySendable(ServerValue.increment(NSNumber(value: 7)))
        #expect(intInc == .dictionary([".sv": .dictionary(["increment": .int(7)])]))

        let dblInc = RtdbValueCodec.toAnySendable(ServerValue.increment(NSNumber(value: 1.25)))
        #expect(dblInc == .dictionary([".sv": .dictionary(["increment": .double(1.25)])]))
    }

    // -- Live Pyric Host Conformance (Sections 1-4 & 11 Shards) --

    @Test("Live host: 11-shard isolation (main + shard-00..shard-09) via Database.useEmulator and reference(fromURL:)")
    func liveHostElevenShardIsolation() async throws {
        guard let (host, port) = try liveEndpointFromEnv() else {
            return
        }

        try await withRtdbSession(host: host, port: port) { auth, mainDb, shardsByName in
            #expect(shardsByName.count == 10)
            let shard00 = try #require(shardsByName["shard-00"])
            let shard01 = try #require(shardsByName["shard-01"])

            // Verify all 11 Database handles share one underlying PyricBridgeClient actor.
            for (_, shardDb) in shardsByName {
                #expect(ObjectIdentifier(shardDb.bridgeClient) == ObjectIdentifier(mainDb.bridgeClient))
                // Idempotent same-endpoint repeat on already configured shard handles.
                shardDb.useEmulator(withHost: host, port: port)
                #expect(ObjectIdentifier(shardDb.bridgeClient) == ObjectIdentifier(mainDb.bridgeClient))
            }

            // Unauthenticated checks across main, shard-00, shard-01, and shard-02..shard-09.
            await expectRtdbPermissionDenied {
                _ = try await mainDb.reference(withPath: "users/anon-probe").getData()
            }
            await expectRtdbPermissionDenied {
                _ = try await shard00.reference(withPath: "rooms/r-anon").getData()
            }
            let publicCatalog = try await shard01.reference(fromURL: "https://shard-01.firebaseio.com/catalog/item-0").getData()
            #expect(publicCatalog.exists() == false)
            await expectRtdbPermissionDenied {
                try await shard01.reference(withPath: "catalog/item-0").setValue(["name": "blocked"] as [String: Any])
            }
            for idx in 2...9 {
                let shardName = String(format: "shard-%02d", idx)
                let shardDb = try #require(shardsByName[shardName])
                await expectRtdbPermissionDenied {
                    _ = try await shardDb.reference(withPath: "shards/\(shardName)/probe").getData()
                }
            }

            // Sign in once via Auth on the same FirebaseApp; session propagates to all 11 RTDB instances.
            let email = "rtdb-s1-\(UUID().uuidString.prefix(8))@example.test"
            let created = try await auth.createUser(withEmail: email, password: "correct-horse-battery")
            let uid = created.user.uid
            #expect(!uid.isEmpty)

            // 1. Default instance (`mainDb`): `/users/$uid` allowed for self, denied for other uids and shard paths.
            let mainUserRef = mainDb.reference(fromURL: "https://default.firebaseio.com/users/\(uid)/meta")
            try await mainUserRef.setValue(["handle": "captain", "shardCount": 11] as [String: Any])
            let mainSnap = try await mainUserRef.getData()
            #expect((mainSnap.value as? [String: Any])?["handle"] as? String == "captain")
            #expect(int64Of((mainSnap.value as? [String: Any])?["shardCount"]) == 11)

            await expectRtdbPermissionDenied {
                try await mainDb.reference(withPath: "users/other-uid/meta").setValue(["handle": "spoof"] as [String: Any])
            }
            await expectRtdbPermissionDenied {
                _ = try await mainDb.reference(withPath: "shards/shard-02/probe").getData()
            }

            // 2. `shard-00`: `/rooms/$roomId` enforces `newData.child("owner").val() === auth.uid`.
            let roomRef = shard00.reference(fromURL: "https://shard-00.firebaseio.com/rooms/room-alpha")
            try await roomRef.setValue(["owner": uid, "topic": "shard-zero"] as [String: Any])
            let roomSnap = try await shard00.reference(withPath: "rooms/room-alpha").getData()
            #expect((roomSnap.value as? [String: Any])?["topic"] as? String == "shard-zero")
            await expectRtdbPermissionDenied {
                try await roomRef.setValue(["owner": "intruder", "topic": "hijack"] as [String: Any])
            }
            // Data written on `mainDb` does not leak into `shard-00` and is denied by `shard-00` rules.
            await expectRtdbPermissionDenied {
                _ = try await shard00.reference(withPath: "users/\(uid)/meta").getData()
            }

            // 3. `shard-01`: `/catalog/$itemId` is read-only; `/ops/$opId` requires `auth.token.role == "ops"`.
            let catalogSnap = try await shard01.reference(withPath: "catalog/item-1").getData()
            #expect(catalogSnap.exists() == false)
            await expectRtdbPermissionDenied {
                try await shard01.reference(withPath: "catalog/item-1").setValue(["sku": "A1"] as [String: Any])
            }
            await expectRtdbPermissionDenied {
                _ = try await shard01.reference(withPath: "ops/deploy-1").getData()
            }
            await expectRtdbPermissionDenied {
                try await shard01.reference(withPath: "ops/deploy-1").setValue(["active": true] as [String: Any])
            }

            // 4. `shard-02`..`shard-09`: prove independent data storage and per-shard rule boundaries across all 8 shards.
            let dedicatedShards = (2...9).map { String(format: "shard-%02d", $0) }
            for (offset, shardName) in dedicatedShards.enumerated() {
                let shardDb = try #require(shardsByName[shardName])
                let canonicalDup = Database.database(app: shardDb.app, url: "https://\(shardName.uppercased()).firebaseio.com/")
                #expect(canonicalDup === shardDb)

                let targetURL = "https://\(shardName).firebaseio.com/shards/\(shardName)/probe"
                let probeRef = shardDb.reference(fromURL: targetURL)
                #expect(probeRef.path == "/shards/\(shardName)/probe")
                #expect(probeRef.url == targetURL)

                let ordinal = offset + 2
                try await probeRef.setValue([
                    "shard": shardName,
                    "ordinal": ordinal,
                    "active": true,
                ] as [String: Any])

                // Also route via emulated host URL with `?ns=<shardName>`.
                let emulatedURL = "http://\(host):\(port)/shards/\(shardName)/probe?ns=\(shardName)"
                let emulatedSnap = try await shardDb.reference(fromURL: emulatedURL).getData()
                let payload = emulatedSnap.value as? [String: Any]
                #expect(payload?["shard"] as? String == shardName)
                #expect(int64Of(payload?["ordinal"]) == Int64(ordinal))
                #expect(payload?["active"] as? Bool == true)

                let neighborShard = dedicatedShards[(offset + 1) % dedicatedShards.count]
                await expectRtdbPermissionDenied {
                    try await shardDb.reference(withPath: "shards/\(neighborShard)/probe").setValue(["leaked": true] as [String: Any])
                }
                let neighborDb = try #require(shardsByName[neighborShard])
                await expectRtdbPermissionDenied {
                    _ = try await neighborDb.reference(withPath: "shards/\(shardName)/probe").getData()
                }
            }
        }
    }

    @Test("Live host: Sections 1-4 conformance (connection/.info, navigation/push, writes/priorities, ServerValue sentinels)")
    func liveHostSectionsOneThroughFourConformance() async throws {
        guard let (host, port) = try liveEndpointFromEnv() else {
            return
        }

        try await withRtdbSession(host: host, port: port) { auth, mainDb, shardsByName in
            let shard02 = try #require(shardsByName["shard-02"])
            let email = "rtdb-ops-\(UUID().uuidString.prefix(8))@example.test"
            let created = try await auth.createUser(withEmail: email, password: "correct-horse-battery")
            let uid = created.user.uid
            let userRoot = mainDb.reference().child("users").child(uid)

            // -- Section 1: reference(), reference(withPath:), .info/connected, .info, goOffline/goOnline --
            let rootRef = mainDb.reference()
            #expect(rootRef.path == "/")
            #expect(rootRef.key == nil)
            #expect(rootRef.parent == nil)

            let slashRef = mainDb.reference(withPath: "///users/\(uid)/nav/profile///")
            #expect(slashRef.path == "/users/\(uid)/nav/profile")
            #expect(slashRef.key == "profile")
            #expect(slashRef.parent?.path == "/users/\(uid)/nav")
            #expect(slashRef.root.path == "/")

            // Trigger initial attach with a real write, then verify `.info/connected` across goOffline/goOnline.
            try await userRoot.child("status").setValue("online")

            let infoConnectedRef = mainDb.reference(withPath: ".info/connected")
            #expect(try await infoConnectedRef.getData().value as? Bool == true)

            let infoRootSnap = try await mainDb.reference(withPath: ".info").getData()
            let infoRootDict = infoRootSnap.value as? [String: Any]
            #expect(infoRootDict?["connected"] as? Bool == true)
            #expect(int64Of(infoRootDict?["serverTimeOffset"]) == 0)
            #expect(int64Of(try await mainDb.reference(withPath: ".info/serverTimeOffset").getData().value) == 0)
            #expect(try await mainDb.reference(withPath: ".info/unknownKey").getData().exists() == false)

            var connectedEvents = infoConnectedRef.valueStream.makeAsyncIterator()
            let initialConnected = try await connectedEvents.next()
            #expect(initialConnected?.value as? Bool == true)

            // Queue an onDisconnect marker on mainDb, then goOffline() to verify both `.info/connected == false`
            // and per-instance disconnect queue drain on the live host while shard-02 stays online.
            try await userRoot.child("presence").setValue("active")
            try await userRoot.child("presence").onDisconnectSetValue("disconnected")
            try await shard02.reference(withPath: "shards/shard-02/state").setValue("shard-online")

            try await mainDb.goOffline()
            let offlineEvent = try await connectedEvents.next()
            #expect(offlineEvent?.value as? Bool == false)
            #expect(try await infoConnectedRef.getData().value as? Bool == false)
            #expect(try await shard02.reference(withPath: " ".trimmingCharacters(in: .whitespaces) + ".info/connected").getData().value as? Bool == true)

            try await mainDb.goOnline()
            let onlineEvent = try await connectedEvents.next()
            #expect(onlineEvent?.value as? Bool == true)
            #expect(try await infoConnectedRef.getData().value as? Bool == true)
            let presenceAfterOffline = try await userRoot.child("presence").getData()
            #expect(presenceAfterOffline.value as? String == "disconnected")

            // -- Section 2: Navigation & Push ID ordering --
            let itemRef = shard02.reference(withPath: "shards/shard-02").child("items/item 42")
            #expect(itemRef.path == "/shards/shard-02/items/item 42")
            #expect(itemRef.key == "item 42")
            #expect(itemRef.parent?.key == "items")
            #expect(itemRef.root.path == "/")
            #expect(itemRef.url == "https://shard-02.firebaseio.com/shards/shard-02/items/item%2042")
            try await itemRef.setValue(["label": "forty-two"] as [String: Any])
            let roundTripFromURL = try await shard02.reference(fromURL: itemRef.url).getData()
            #expect((roundTripFromURL.value as? [String: Any])?["label"] as? String == "forty-two")

            let pushListRef = userRoot.child("events")
            var generatedKeys: [String] = []
            for idx in 0..<5 {
                let pushed = pushListRef.childByAutoId()
                let key = try #require(pushed.key)
                #expect(key.count == 20)
                generatedKeys.append(key)
                try await pushed.setValue(["seq": idx] as [String: Any])
            }
            #expect(generatedKeys == generatedKeys.sorted())
            #expect(Set(generatedKeys).count == 5)
            let eventsSnap = try await pushListRef.getData()
            #expect(eventsSnap.childrenSnapshots.compactMap(\.key) == generatedKeys)

            // -- Section 3: Write Operations (async + completion-block forms, priorities, updates, deletes) --
            let writesRef = userRoot.child("writes")
            try await writesRef.child("types").setValue([
                "text": "alpha",
                "oneInt": 1,
                "zeroInt": 0,
                "flagTrue": true,
                "flagFalse": false,
                "ratio": 2.5,
                "tags": ["ios", "rtdb"],
            ] as [String: Any])

            let typesSnap = try await writesRef.child("types").getData()
            let typesDict = try #require(typesSnap.value as? [String: Any])
            #expect(typesDict["text"] as? String == "alpha")
            #expect(int64Of(typesDict["oneInt"]) == 1)
            #expect(int64Of(typesDict["zeroInt"]) == 0)
            #expect(typesDict["flagTrue"] as? Bool == true)
            #expect(typesDict["flagFalse"] as? Bool == false)
            #expect(doubleOf(typesDict["ratio"]) == 2.5)
            #expect((typesDict["tags"] as? [Any])?.compactMap { $0 as? String } == ["ios", "rtdb"])

            // Completion-block setValue + setValue(nil) deletion.
            let cbNode = writesRef.child("completionNode")
            try await withCompletionRef { done in
                cbNode.setValue("created-via-callback", withCompletionBlock: done)
            }
            #expect(try await cbNode.getData().value as? String == "created-via-callback")

            try await withCompletionRef { done in
                cbNode.setValue(nil, withCompletionBlock: done)
            }
            #expect(try await cbNode.getData().exists() == false)

            // Async setValue(nil) deletion.
            let tempNode = writesRef.child("ephemeral")
            try await tempNode.setValue("temporary")
            #expect(try await tempNode.getData().exists() == true)
            try await tempNode.setValue(nil)
            #expect(try await tempNode.getData().exists() == false)

            // setPriority (number & string) without altering node value.
            let prioNode = writesRef.child("prioOnly")
            try await prioNode.setValue(["title": "pinned"] as [String: Any])
            try await prioNode.setPriority(42)
            let prioSnap1 = try await prioNode.getData()
            #expect((prioSnap1.value as? [String: Any])?["title"] as? String == "pinned")
            #expect(int64Of(prioSnap1.priority) == 42)

            try await withCompletionRef { done in
                prioNode.setPriority("tier-gold", withCompletionBlock: done)
            }
            let prioSnap2 = try await prioNode.getData()
            #expect(prioSnap2.priority as? String == "tier-gold")

            // setValue(_:andPriority:) atomic write (async + completion).
            let rankedNode = writesRef.child("ranked")
            try await rankedNode.setValue("first", andPriority: 10)
            let rankedSnap1 = try await rankedNode.getData()
            #expect(rankedSnap1.value as? String == "first")
            #expect(int64Of(rankedSnap1.priority) == 10)

            try await withCompletionRef { done in
                rankedNode.setValue("second", andPriority: "p-two", withCompletionBlock: done)
            }
            let rankedSnap2 = try await rankedNode.getData()
            #expect(rankedSnap2.value as? String == "second")
            #expect(rankedSnap2.priority as? String == "p-two")

            // updateChildValues multi-path atomic update preserving siblings and deleting null paths.
            let profileRef = writesRef.child("profile")
            try await profileRef.setValue([
                "displayName": "Pilot",
                "obsolete": "remove-me",
                "stats": ["flights": 3, "hours": 12],
            ] as [String: Any])
            try await profileRef.updateChildValues([
                "role": "commander",
                "obsolete": NSNull(),
                "stats/hours": 19,
            ])
            let updatedProfile = try #require(try await profileRef.getData().value as? [String: Any])
            #expect(updatedProfile["displayName"] as? String == "Pilot")
            #expect(updatedProfile["role"] as? String == "commander")
            #expect(updatedProfile["obsolete"] == nil)
            let updatedStats = try #require(updatedProfile["stats"] as? [String: Any])
            #expect(int64Of(updatedStats["flights"]) == 3)
            #expect(int64Of(updatedStats["hours"]) == 19)

            // removeValue (async + completion).
            try await profileRef.child("stats").removeValue()
            #expect(try await profileRef.child("stats").getData().exists() == false)
            try await withCompletionRef { done in
                profileRef.removeValue(completionBlock: done)
            }
            #expect(try await profileRef.getData().exists() == false)

            // -- Section 4: ServerValue Sentinels (timestamp & increment) --
            let sentinelsRef = userRoot.child("sentinels")
            try await sentinelsRef.setValue([
                "createdAt": ServerValue.timestamp(),
            ] as [String: Any])
            try await sentinelsRef.updateChildValues([
                "touchedAt": ServerValue.timestamp(),
            ])
            let tsSnap = try #require(try await sentinelsRef.getData().value as? [String: Any])
            let createdAtMs = try #require(int64Of(tsSnap["createdAt"]))
            let touchedAtMs = try #require(int64Of(tsSnap["touchedAt"]))
            #expect(createdAtMs > 1_700_000_000_000)
            #expect(touchedAtMs >= createdAtMs)

            let counterRef = sentinelsRef.child("counter")
            // Increment on missing path initializes from 0 -> 10.
            try await counterRef.setValue(ServerValue.increment(10))
            #expect(int64Of(try await counterRef.getData().value) == 10)
            // Negative integer delta: 10 - 3 = 7.
            try await counterRef.setValue(ServerValue.increment(-3))
            #expect(int64Of(try await counterRef.getData().value) == 7)
            // NSNumber integer delta: 7 + 5 = 12.
            try await counterRef.setValue(ServerValue.increment(NSNumber(value: 5)))
            #expect(int64Of(try await counterRef.getData().value) == 12)
            // Floating-point delta: 12 + 0.5 = 12.5.
            try await counterRef.setValue(ServerValue.increment(0.5))
            #expect(doubleOf(try await counterRef.getData().value) == 12.5)
        }
    }

    // -- Helpers --

    internal func liveEndpointFromEnv() throws -> (host: String, port: Int)? {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return nil
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)
        return (host, port)
    }

    internal func withRtdbSession(
        host: String,
        port: Int,
        body: (Auth, Database, [String: Database]) async throws -> Void
    ) async throws {
        let app = FirebaseApp(name: "rtdb-live-\(UUID().uuidString)")
        let mainDb = Database.database(app: app)
        var shards: [String: Database] = [:]
        for idx in 0...9 {
            let name = String(format: "shard-%02d", idx)
            shards[name] = Database.database(app: app, url: "https://\(name).firebaseio.com")
        }
        // Configure bridge exclusively via Database.useEmulator(withHost:port:) without touching Firestore.
        mainDb.useEmulator(withHost: host, port: port)
        let auth = Auth.auth(app: app)

        do {
            try await body(auth, mainDb, shards)
            await mainDb.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
        } catch {
            await mainDb.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
            throw error
        }
    }

    internal func withCompletionRef(
        _ invoke: (@escaping @Sendable (Error?, DatabaseReference) -> Void) -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            invoke { error, _ in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: ())
                }
            }
        }
    }

    internal func expectRtdbPermissionDenied(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            Issue.record("Expected permission-denied error, but operation succeeded")
        } catch let bridgeError as PyricBridgeError {
            let isDenied = bridgeError.code == .permissionDenied
                || bridgeError.rawCode == "PERMISSION_DENIED"
            #expect(isDenied, "Unexpected bridge error code: \(bridgeError.rawCode)")
        } catch {
            Issue.record("Expected PyricBridgeError permission-denied, got: \(error)")
        }
    }

    internal func int64Of(_ raw: Any?) -> Int64? {
        if let v = raw as? Int64 { return v }
        if let v = raw as? Int { return Int64(v) }
        if let v = raw as? Double { return Int64(v) }
        if let n = raw as? NSNumber { return n.int64Value }
        return nil
    }

    internal func doubleOf(_ raw: Any?) -> Double? {
        if let v = raw as? Double { return v }
        if let v = raw as? Float { return Double(v) }
        if let v = raw as? Int64 { return Double(v) }
        if let v = raw as? Int { return Double(v) }
        if let n = raw as? NSNumber { return n.doubleValue }
        return nil
    }
}
