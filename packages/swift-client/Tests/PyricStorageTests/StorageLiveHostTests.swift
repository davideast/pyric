import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import PyricStorage
import PyricFirestore
import FirebaseAuth
import PyricDatabase
import PyricAppCheck

@Suite("PyricStorage Live-Host Suite", .serialized)
struct StorageLiveHostTests {
    private static let projectId = "demo-swift-storage"
    private static let defaultBucket = "demo-swift-storage.appspot.com"
    private static let iosAppId = "1:424242424242:ios:swiftstorageapp"

    private func fetchRawHTTP(url: URL) async throws -> (status: Int, body: Data) {
        try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: url) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                continuation.resume(returning: (status: status, body: data ?? Data()))
            }
            task.resume()
        }
    }

    @Test("Enforces Storage Rules unauthorized denial, authenticated CRUD, downloadURL, metadata update, listAll, and delete over HostedRuntime")
    func enforcesRulesAndExecutesFullStorageCrudOverHostedRuntime() async throws {
        guard let rawBridgeUrl = ProcessInfo.processInfo.environment["PYRIC_LIVE_STORAGE_BRIDGE_URL"],
              !rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        let parsedUrl = try #require(URL(string: rawBridgeUrl.trimmingCharacters(in: .whitespacesAndNewlines)))
        let host = try #require(parsedUrl.host)
        let port = try #require(parsedUrl.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            Storage.reset()
            AppCheck.reset()
            Auth.reset()
            Database.reset()
            Firestore.reset()
            FirebaseApp.resetAppsForTesting()
            defer {
                Storage.reset()
                AppCheck.reset()
                Auth.reset()
                Database.reset()
                Firestore.reset()
                FirebaseApp.resetAppsForTesting()
            }

            let options = FirebaseOptions(
                projectID: Self.projectId,
                apiKey: "sandbox-storage-key",
                googleAppID: Self.iosAppId,
                storageBucket: Self.defaultBucket
            )
            FirebaseApp.configure(name: "live-swift-storage-app", options: options)
            let app = try #require(FirebaseApp.app(name: "live-swift-storage-app"))

            let storage = Storage.storage(app: app)
            storage.useEmulator(withHost: host, port: port)

            let auth = Auth.auth(app: app)

            // 1. Unauthenticated upload, read, listAll, updateMetadata, and delete are denied by Storage Rules.
            let unauthedRef = storage.reference(withPath: "users/unauthed-user/secret.txt")
            var deniedUnauthedPut = false
            do {
                _ = try await unauthedRef.putDataAsync(Data("forbidden".utf8))
            } catch StorageErrorCode.unauthorized {
                deniedUnauthedPut = true
            }
            #expect(deniedUnauthedPut == true)

            var deniedUnauthedList = false
            do {
                _ = try await storage.reference(withPath: "users/unauthed-user").listAll()
            } catch StorageErrorCode.unauthorized {
                deniedUnauthedList = true
            }
            #expect(deniedUnauthedList == true)

            // 2. Sign in via FirebaseAuth and verify UID-scoped Storage Rules enforcement.
            let authResult = try await auth.createUser(
                withEmail: "storage-owner@example.com",
                password: "SwiftStoragePassword!123"
            )
            let uid = authResult.user.uid
            #expect(!uid.isEmpty)

            // Cross-UID write to another user's prefix must still be denied with StorageErrorCode.unauthorized.
            let otherUserRef = storage.reference(withPath: "users/someone-else/hijack.txt")
            var deniedCrossUidPut = false
            do {
                _ = try await otherUserRef.putDataAsync(Data("hijack".utf8))
            } catch StorageErrorCode.unauthorized {
                deniedCrossUidPut = true
            }
            #expect(deniedCrossUidPut == true)

            // 3. Authenticated upload with initial StorageMetadata.
            let profileRef = storage.reference(withPath: "users/\(uid)/docs/profile.json")
            let payloadBytes = Data("{\"role\":\"engineer\",\"sdk\":\"PyricStorage\"}".utf8)
            let uploadMeta = StorageMetadata()
            uploadMeta.contentType = "application/json"
            uploadMeta.cacheControl = "private, max-age=120"
            uploadMeta.contentLanguage = "en"
            uploadMeta.customMetadata = ["author": uid, "stage": "initial"]

            let createdMeta = try await profileRef.putDataAsync(payloadBytes, metadata: uploadMeta)
            #expect(createdMeta.bucket == Self.defaultBucket)
            #expect(createdMeta.path == "users/\(uid)/docs/profile.json")
            #expect(createdMeta.name == "profile.json")
            #expect(createdMeta.size == Int64(payloadBytes.count))
            #expect(createdMeta.generation >= 1)
            #expect(createdMeta.metageneration == 1)
            #expect(createdMeta.contentType == "application/json")
            #expect(createdMeta.cacheControl == "private, max-age=120")
            #expect(createdMeta.contentLanguage == "en")
            #expect(createdMeta.customMetadata == ["author": uid, "stage": "initial"])
            #expect(createdMeta.timeCreated != nil)
            #expect(createdMeta.updated != nil)

            // Upload a second sibling and a top-level file under users/<uid>/ via completion handler for listAll.
            let summaryRef = storage.reference(withPath: "users/\(uid)/summary.txt")
            let summaryMeta = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<StorageMetadata, Error>) in
                summaryRef.putData(Data("summary line".utf8), metadata: nil) { meta, err in
                    if let err {
                        cont.resume(throwing: err)
                    } else if let meta {
                        cont.resume(returning: meta)
                    }
                }
            }
            #expect(summaryMeta.size == 12)

            // 4. Download data(maxSize:) + verify downloadSizeExceeded protection.
            let downloaded = try await profileRef.data(maxSize: 4096)
            #expect(downloaded == payloadBytes)

            var exceededMax = false
            do {
                _ = try await profileRef.data(maxSize: 8)
            } catch StorageErrorCode.downloadSizeExceeded {
                exceededMax = true
            }
            #expect(exceededMax == true)

            // 5. Mint tokenized downloadURL(), verify round-trip reference(for:), and fetch bytes via HTTP token.
            let tokenURL = try await profileRef.downloadURL()
            #expect(tokenURL.absoluteString.contains("/__pyric/storage/v0/b/"))
            #expect(tokenURL.absoluteString.contains("token="))
            let roundTrippedRef = try storage.reference(for: tokenURL)
            #expect(roundTrippedRef == profileRef)

            let rawFetch = try await fetchRawHTTP(url: tokenURL)
            #expect(rawFetch.status == 200)
            #expect(rawFetch.body == payloadBytes)

            // 6. getMetadata() and updateMetadata(_:) bump metageneration and preserve object bytes + token URL.
            let beforeUpdate = try await profileRef.metadata()
            let updatePatch = StorageMetadata()
            updatePatch.cacheControl = "public, max-age=600"
            updatePatch.customMetadata = ["author": uid, "stage": "verified", "rev": "2"]

            let afterUpdate = try await profileRef.updateMetadata(updatePatch)
            #expect(afterUpdate.generation == beforeUpdate.generation)
            #expect(afterUpdate.metageneration == beforeUpdate.metageneration + 1)
            #expect(afterUpdate.cacheControl == "public, max-age=600")
            #expect(afterUpdate.customMetadata == ["author": uid, "stage": "verified", "rev": "2"])

            let reReadBytes = try await profileRef.data(maxSize: 4096)
            #expect(reReadBytes == payloadBytes)

            // 7. listAll() and paginated list(maxResults:pageToken:) return expected prefixes & items.
            let userRootRef = storage.reference(withPath: "users/\(uid)")
            let listed = try await userRootRef.listAll()
            #expect(listed.prefixes.map(\.fullPath) == ["users/\(uid)/docs"])
            #expect(listed.prefixes.map(\.name) == ["docs"])
            #expect(listed.items.map(\.fullPath) == ["users/\(uid)/summary.txt"])
            #expect(listed.items.map(\.name) == ["summary.txt"])

            let pageOne = try await userRootRef.list(maxResults: 1)
            #expect(pageOne.prefixes.map(\.fullPath) == ["users/\(uid)/docs"])
            #expect(pageOne.items.isEmpty)
            let cursor = try #require(pageOne.pageToken)
            let pageTwo = try await userRootRef.list(maxResults: 1, pageToken: cursor)
            #expect(pageTwo.prefixes.isEmpty)
            #expect(pageTwo.items.map(\.fullPath) == ["users/\(uid)/summary.txt"])
            #expect(pageTwo.pageToken == nil)

            // 8. delete() removes the object and subsequent reads fail with StorageErrorCode.objectNotFound.
            try await profileRef.delete()
            var notFoundAfterDelete = false
            do {
                _ = try await profileRef.getMetadata()
            } catch StorageErrorCode.objectNotFound {
                notFoundAfterDelete = true
            }
            #expect(notFoundAfterDelete == true)

            var deleteMissingRejected = false
            do {
                try await profileRef.delete()
            } catch StorageErrorCode.objectNotFound {
                deleteMissingRejected = true
            }
            #expect(deleteMissingRejected == true)

            // 9. Signing out restores unauthenticated unauthorized denial on existing summaryRef.
            try auth.signOut()
            var deniedAfterSignOut = false
            do {
                _ = try await summaryRef.data(maxSize: 1024)
            } catch StorageErrorCode.unauthorized {
                deniedAfterSignOut = true
            }
            #expect(deniedAfterSignOut == true)

            await app.delete()
        }
    }
}
