import Foundation
import Testing
import PyricAppCheck
import PyricFirestore
import FirebaseAuth
import PyricDatabase

@Suite("Cross-Target Singleton Isolation Suite")
struct CrossTargetSingletonIsolationTests {

    @Test("FirebaseGlobalTestGate prevents default-app and global reset races across concurrent tasks")
    func concurrentSingletonContentionRegression() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for iteration in 0..<8 {
                group.addTask {
                    try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
                        AppCheck.reset()
                        FirebaseApp.resetAppsForTesting()
                        defer {
                            AppCheck.reset()
                            FirebaseApp.resetAppsForTesting()
                        }

                        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
                        FirebaseApp.configure(
                            options: FirebaseOptions(
                                projectID: "demo-appcheck-unit-\(iteration)",
                                googleAppID: "1:111111111111:ios:defaultapp"
                            )
                        )
                        try await Task.sleep(nanoseconds: 1_000_000)
                        let defaultCheck = AppCheck.appCheck()
                        let explicitCheck = try #require(AppCheck.appCheck(app: FirebaseApp.app()))
                        #expect(defaultCheck === explicitCheck)
                        #expect(defaultCheck.app.options.projectID == "demo-appcheck-unit-\(iteration)")
                    }
                }

                group.addTask {
                    try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
                        Database.reset()
                        FirebaseApp.resetAppsForTesting()
                        defer {
                            Database.reset()
                            FirebaseApp.resetAppsForTesting()
                        }

                        try await Task.sleep(nanoseconds: 500_000)
                        let db = Database.database()
                        #expect(db.url == "https://default.firebaseio.com")
                    }
                }

                group.addTask {
                    await FirebaseGlobalTestGate.shared.withExclusiveAccess {
                        defer { Auth.reset() }
                        let app = FirebaseApp(name: "emu-race-\(iteration)-\(UUID().uuidString)")
                        let auth = Auth.auth(app: app)
                        let firestore = Firestore.firestore(app: app)
                        auth.useEmulator(withHost: "127.0.0.1", port: 9099)
                        let authEndpoint = await auth.bridgeClient.endpoint
                        let firestoreEndpoint = await firestore.bridgeClient.endpoint
                        #expect(authEndpoint.port == 9099)
                        #expect(firestoreEndpoint == authEndpoint)
                        Auth.reset()
                    }
                }
            }

            try await group.waitForAll()
        }
    }
}
