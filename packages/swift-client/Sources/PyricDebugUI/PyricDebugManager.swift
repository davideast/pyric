import Foundation
import SwiftUI
import PyricFirestore
import FirebaseAuth

/// Coordinates on-device debug companion state, user impersonation, and diagnostics.
@MainActor
public final class PyricDebugManager: ObservableObject {
    public static let shared = PyricDebugManager()

    @Published public var isPresented: Bool = false
    @Published public var users: [SandboxUserRecord] = []
    @Published public var isLoadingUsers: Bool = false
    @Published public var activeLens: AuthLens = .anon
    @Published public var recentDenials: [RulesDenialReport] = []
    @Published public var selectedTab: Int = 0

    public let auth: Auth
    public let bridgeClient: PyricBridgeClient
    public let diagnostics: PyricDebugDiagnostics

    private var lensObserverTask: Task<Void, Never>?
    private var denialObserverTask: Task<Void, Never>?

    public var isAdminBypass: Bool {
        activeLens == .admin
    }

    public var latestDenial: RulesDenialReport? {
        recentDenials.first
    }

    public var activeIdentityTitle: String {
        switch activeLens {
        case .admin:
            return "ADMIN"
        case .anon:
            return "ANONYMOUS"
        case .appSession:
            return "APP SESSION"
        case .custom:
            return "CUSTOM"
        case .asUser(let uid, let tenant, _):
            if let user = users.first(where: { $0.uid == uid }) {
                if let email = user.email {
                    return email
                }
                if let displayName = user.displayName {
                    return displayName
                }
            }
            if let tenant, !tenant.isEmpty {
                return "\(uid) (\(tenant))"
            }
            return uid
        }
    }

    public init(
        auth: Auth = .auth(),
        bridgeClient: PyricBridgeClient? = nil,
        diagnostics: PyricDebugDiagnostics = .shared
    ) {
        self.auth = auth
        let resolvedBridge = bridgeClient ?? auth.bridgeClient
        self.bridgeClient = resolvedBridge
        self.diagnostics = diagnostics
        self.activeLens = auth.currentAuthLens()
        self.recentDenials = diagnostics.history

        diagnostics.attach(to: resolvedBridge)

        startObservers()
    }

    public convenience init(
        firestore: Firestore,
        auth: Auth = .auth(),
        diagnostics: PyricDebugDiagnostics = .shared
    ) {
        self.init(
            auth: auth,
            bridgeClient: firestore.bridgeClient,
            diagnostics: diagnostics
        )
    }

    deinit {
        lensObserverTask?.cancel()
        denialObserverTask?.cancel()
    }

    private func startObservers() {
        lensObserverTask?.cancel()
        lensObserverTask = Task { [weak self] in
            guard let self else { return }
            for await lens in self.auth.authLensStream {
                guard !Task.isCancelled else { break }
                self.activeLens = lens
            }
        }

        denialObserverTask?.cancel()
        denialObserverTask = Task { [weak self] in
            guard let self else { return }
            for await report in self.diagnostics.denialStream {
                guard !Task.isCancelled else { break }
                self.recentDenials.insert(report, at: 0)
                if self.recentDenials.count > 20 {
                    self.recentDenials.removeLast()
                }
            }
        }
    }

    /// Fetches sandbox users from the bridge using `auth.listUsers`.
    public func refreshUsers() async {
        isLoadingUsers = true
        defer { isLoadingUsers = false }
        do {
            let rawUsers = try await bridgeClient.authListUsers()
            self.users = rawUsers.compactMap { SandboxUserRecord.fromWire($0) }
        } catch {
            // Retain existing users if fetch fails
        }
    }

    /// Switches the active impersonation identity to the given sandbox user.
    public func selectUser(_ user: SandboxUserRecord) {
        let claims = user.customClaims.isEmpty ? nil : user.customClaims
        auth.switchLens(.asUser(uid: user.uid, tenant: user.tenantId, token: claims))
    }

    /// Toggles the Admin Bypass lens mode.
    public func toggleAdminBypass(_ enabled: Bool) {
        if enabled {
            auth.switchLens(.admin)
        } else {
            auth.switchLens(nil)
        }
    }

    /// Switches to the Anonymous (unauthenticated) identity.
    public func selectAnon() {
        auth.switchLens(.anon)
    }

    /// Switches to the App Session (mirroring the browser sandbox session).
    public func selectAppSession() {
        auth.switchLens(.appSession)
    }

    /// Flushes all recorded rule denial reports.
    public func clearDenials() {
        recentDenials.removeAll()
        diagnostics.clear()
    }

    /// Manually records a denial report for testing or diagnostics.
    public func recordDenial(_ report: RulesDenialReport) {
        diagnostics.record(denial: report)
    }
}
