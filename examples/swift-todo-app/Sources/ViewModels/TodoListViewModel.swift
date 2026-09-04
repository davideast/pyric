import Foundation
import SwiftUI
import PyricFirestore
import FirebaseAuth
import PyricDebugUI

public struct SecurityRuleDenial: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let code: String
    public let message: String
    public let method: String?
    public let path: String?
    public let line: Int?
    public let expression: String?
    public let reasons: [String]

    public init(
        code: String,
        message: String,
        method: String? = nil,
        path: String? = nil,
        line: Int? = nil,
        expression: String? = nil,
        reasons: [String] = []
    ) {
        self.code = code
        self.message = message
        self.method = method
        self.path = path
        self.line = line
        self.expression = expression
        self.reasons = reasons
    }
}

@MainActor
public final class TodoListViewModel: ObservableObject {
    @Published public private(set) var todos: [TodoItem] = []
    @Published public private(set) var isConnected: Bool = false
    @Published public private(set) var statusMessage: String = "Connecting to Pyric..."
    @Published public private(set) var hasError: Bool = false
    @Published public private(set) var errorMessage: String? = nil
    @Published public private(set) var ruleDenial: SecurityRuleDenial? = nil
    @Published public private(set) var currentUser: User? = nil
    @Published public private(set) var currentLens: AuthLens = .anon
    @Published public private(set) var effectiveUserId: String? = nil

    private var listenTask: Task<Void, Never>?
    private var authTask: Task<Void, Never>?
    public let db: Firestore
    public let auth: Auth
    public let debugManager: PyricDebugManager

    public init(
        firestore: Firestore = Firestore.firestore(),
        auth: Auth = Auth.auth()
    ) {
        self.db = firestore
        self.auth = auth
        self.debugManager = PyricDebugManager(firestore: firestore, auth: auth)
        self.currentUser = auth.currentUser
        self.currentLens = auth.currentAuthLens()
        self.effectiveUserId = resolveEffectiveUserId(lens: self.currentLens, user: self.currentUser)

        startAuthObservation()
        startListening()
    }

    deinit {
        listenTask?.cancel()
        authTask?.cancel()
    }

    private func resolveEffectiveUserId(lens: AuthLens, user: User?) -> String? {
        switch lens {
        case .asUser(let uid, _, _):
            return uid
        case .admin:
            return user?.uid ?? "admin"
        case .appSession, .anon, .custom:
            return user?.uid
        }
    }

    private func startAuthObservation() {
        authTask?.cancel()
        authTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await lens in self.auth.authLensStream {
                guard !Task.isCancelled else { break }
                self.currentLens = lens
                self.currentUser = self.auth.currentUser
                let newUid = self.resolveEffectiveUserId(lens: lens, user: self.currentUser)
                if newUid != self.effectiveUserId {
                    self.effectiveUserId = newUid
                    self.startListening()
                }
            }
        }
    }

    /// Connects to the Pyric sandbox bridge and starts real-time streaming of the 'todos' collection.
    public func startListening() {
        stopListening()

        statusMessage = "Connecting to Pyric Sandbox..."
        hasError = false
        errorMessage = nil
        ruleDenial = nil

        guard let uid = effectiveUserId, !uid.isEmpty else {
            statusMessage = "Not signed in. Tap the Pyric Chip or sign in below."
            todos = []
            return
        }

        let query = (currentLens == .admin)
            ? db.collection("todos")
            : db.collection("todos").whereField("userId", isEqualTo: uid)

        listenTask = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                for try await snapshot in query.snapshots {
                    guard !Task.isCancelled else { break }
                    self.isConnected = true
                    self.hasError = false
                    self.errorMessage = nil
                    self.ruleDenial = nil
                    self.statusMessage = "Connected as \(uid)"

                    let mapped = snapshot.documents.compactMap { doc in
                        TodoItem(id: doc.documentID, data: doc.data())
                    }

                    self.todos = mapped.sorted { lhs, rhs in
                        guard let lDate = lhs.createdAt?.dateValue() else { return false }
                        guard let rDate = rhs.createdAt?.dateValue() else { return true }
                        return lDate > rDate
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                self.isConnected = false
                self.hasError = true
                self.errorMessage = error.localizedDescription
                self.statusMessage = "Disconnected: \(error.localizedDescription)"
                if let bridgeError = error as? PyricBridgeError {
                    self.extractRuleDenial(bridgeError, operation: "Listen")
                }
            }
        }
    }

    /// Unsubscribes and cancels the background streaming task.
    public func stopListening() {
        listenTask?.cancel()
        listenTask = nil
        isConnected = false
    }

    /// Adds a new todo document for the active user.
    public func addTodo(title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let uid = effectiveUserId else {
            self.errorMessage = "Must be signed in to add todos"
            self.hasError = true
            return
        }

        do {
            _ = try await db.collection("todos").addDocument(data: [
                "title": trimmed,
                "completed": false,
                "userId": uid,
                "createdAt": FieldValue.serverTimestamp()
            ])
        } catch {
            handleOperationError(error, operation: "Add task")
        }
    }

    /// Deliberately attempts an unauthorized write (mismatched userId) to verify rule enforcement.
    public func triggerUnauthorizedWrite() async {
        do {
            _ = try await db.collection("todos").addDocument(data: [
                "title": "Unauthorized Hacker Todo",
                "completed": false,
                "userId": "attacker-wrong-uid-999",
                "createdAt": FieldValue.serverTimestamp()
            ])
        } catch {
            handleOperationError(error, operation: "Create unauthorized todo")
        }
    }

    /// Toggles the completion status of a todo document.
    public func toggleTodo(item: TodoItem) async {
        do {
            let nextState = !item.completed
            try await db.collection("todos").document(item.id).updateData([
                "completed": nextState
            ])
        } catch {
            handleOperationError(error, operation: "Toggle task")
        }
    }

    /// Deletes a todo document from Firestore.
    public func deleteTodo(item: TodoItem) async {
        do {
            try await db.collection("todos").document(item.id).delete()
        } catch {
            handleOperationError(error, operation: "Delete task")
        }
    }

    public func signInAnonymously() async {
        hasError = false
        errorMessage = nil
        do {
            _ = try await auth.signInAnonymously()
        } catch {
            self.errorMessage = "Anonymous sign-in failed: \(error.localizedDescription)"
            self.statusMessage = self.errorMessage!
            self.hasError = true
        }
    }

    public func signIn(email: String, password: String) async {
        hasError = false
        errorMessage = nil
        do {
            _ = try await auth.signIn(withEmail: email, password: password)
        } catch {
            let desc = error.localizedDescription
            if desc.contains("user-not-found") || desc.contains("No user found") {
                do {
                    _ = try await auth.createUser(withEmail: email, password: password)
                    return
                } catch let createErr {
                    self.errorMessage = "Sign-in failed: \(createErr.localizedDescription)"
                    self.statusMessage = self.errorMessage!
                    self.hasError = true
                    return
                }
            }
            self.errorMessage = "Sign-in failed: \(error.localizedDescription)"
            self.statusMessage = self.errorMessage!
            self.hasError = true
        }
    }

    public func createUser(email: String, password: String) async {
        hasError = false
        errorMessage = nil
        do {
            _ = try await auth.createUser(withEmail: email, password: password)
        } catch {
            self.errorMessage = "Create account failed: \(error.localizedDescription)"
            self.statusMessage = self.errorMessage!
            self.hasError = true
        }
    }

    public func signOut() {
        stopListening()
        auth.switchLens(nil)
        try? auth.signOut()
        self.effectiveUserId = nil
        self.currentUser = nil
        self.currentLens = .anon
        self.todos = []
        self.statusMessage = "Not signed in. Tap the Pyric Chip or sign in below."
        self.hasError = false
        self.errorMessage = nil
        self.ruleDenial = nil
    }

    public func dismissError() {
        hasError = false
        errorMessage = nil
        ruleDenial = nil
        if isConnected, let uid = effectiveUserId {
            statusMessage = "Connected as \(uid)"
        }
    }

    private func handleOperationError(_ error: Error, operation: String) {
        self.hasError = true
        self.errorMessage = error.localizedDescription
        self.statusMessage = "\(operation) failed: \(error.localizedDescription)"

        if let bridgeError = error as? PyricBridgeError {
            extractRuleDenial(bridgeError, operation: operation)
        } else {
            self.ruleDenial = nil
        }
    }

    private func extractRuleDenial(_ bridgeError: PyricBridgeError, operation: String) {
        let dc = bridgeError.denialContext
        let reasons: [String] = dc?["reasons"]?.arrayValue?.compactMap { $0.stringValue }
            ?? (bridgeError.code == .permissionDenied ? [bridgeError.message] : [])
        let path = dc?["request"]?["path"]?.stringValue ?? dc?["path"]?.stringValue
        let method = dc?["request"]?["method"]?.stringValue ?? dc?["method"]?.stringValue ?? operation.uppercased()
        let line = dc?["rule"]?["line"]?.intValue.map { Int($0) }
        let expr = dc?["rule"]?["expression"]?.stringValue

        self.ruleDenial = SecurityRuleDenial(
            code: bridgeError.rawCode,
            message: bridgeError.message,
            method: method,
            path: path,
            line: line,
            expression: expr,
            reasons: reasons
        )
    }

    public func deleteTodos(at indexSet: IndexSet) {
        let itemsToDelete = indexSet.map { todos[$0] }
        Task {
            for item in itemsToDelete {
                await deleteTodo(item: item)
            }
        }
    }
}
