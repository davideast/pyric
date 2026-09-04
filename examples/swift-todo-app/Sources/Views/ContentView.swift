import SwiftUI
import PyricFirestore
import FirebaseAuth
import PyricDebugUI

public struct ContentView: View {
    @ObservedObject var viewModel: TodoListViewModel
    @State private var newTodoTitle: String = ""
    @State private var emailInput: String = "alice@example.com"
    @State private var passwordInput: String = "password123"
    @State private var isShowingAuthDetails: Bool = false

    public init(viewModel: TodoListViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                statusBanner

                if let denial = viewModel.ruleDenial {
                    securityRulesDenialCard(denial)
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                }

                if viewModel.effectiveUserId == nil {
                    authPromptCard
                        .padding()
                } else {
                    authenticatedHeader
                        .padding(.horizontal)
                        .padding(.vertical, 6)

                    addTodoBar
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                        .background(Color.secondary.opacity(0.12))

                    if viewModel.todos.isEmpty {
                        emptyStateView
                    } else {
                        todoListView
                    }
                }
            }
            .pyricDebugOverlay(manager: viewModel.debugManager)
            .navigationTitle("Pyric Swift Todos")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task {
                            await viewModel.triggerUnauthorizedWrite()
                        }
                    } label: {
                        Image(systemName: "shield.slash")
                            .foregroundColor(.red)
                    }
                    .help("Trigger Unauthorized Write (Verify Security Rules)")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        viewModel.startListening()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help("Reload")
                }
            }
        }
    }

    private var statusBanner: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(viewModel.hasError ? Color.red : (viewModel.isConnected ? Color.green : Color.orange))
                .frame(width: 10, height: 10)
            Text(viewModel.hasError ? (viewModel.errorMessage ?? viewModel.statusMessage) : viewModel.statusMessage)
                .font(.caption)
                .foregroundColor(viewModel.hasError ? .red : .secondary)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(viewModel.hasError ? Color.red.opacity(0.08) : Color.secondary.opacity(0.08))
    }

    private var authenticatedHeader: some View {
        HStack {
            Image(systemName: "person.crop.circle.fill")
                .foregroundColor(.blue)
            Text("User: \(viewModel.effectiveUserId ?? "")")
                .font(.subheadline.bold())
                .lineLimit(1)
            Spacer()
            Button("Sign Out") {
                viewModel.signOut()
            }
            .font(.caption)
            .buttonStyle(.bordered)
        }
    }

    private var authPromptCard: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 56))
                .foregroundColor(.orange)

            Text("Authentication Required")
                .font(.title2.bold())

            Text("This app enforces Firestore security rules:\n`allow read, write: if request.auth.uid == resource.data.userId;`")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
                .padding(.horizontal)

            if viewModel.hasError, let err = viewModel.errorMessage {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                }
                .padding(8)
                .background(Color.red.opacity(0.1))
                .cornerRadius(8)
            }

            VStack(spacing: 12) {
                Button {
                    Task {
                        await viewModel.signInAnonymously()
                    }
                } label: {
                    Label("Sign In Anonymously", systemImage: "person.fill.questionmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button {
                    Task {
                        await viewModel.signIn(email: emailInput, password: passwordInput)
                    }
                } label: {
                    Label("Sign In as Alice (Email/Password)", systemImage: "envelope.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Text("Or tap the Pyric Chip floating above to 1-tap impersonate sandbox users or toggle Admin Bypass.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
            .frame(maxWidth: 340)

            Spacer()
        }
    }

    private func securityRulesDenialCard(_ denial: SecurityRuleDenial) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "shield.slash.fill")
                    .foregroundColor(.red)
                    .font(.subheadline)
                Text("Security Rules Denial")
                    .font(.subheadline.bold())
                    .foregroundColor(.red)

                Spacer()

                Text(denial.code)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.red.opacity(0.15))
                    .foregroundColor(.red)
                    .cornerRadius(4)

                Button {
                    viewModel.dismissError()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                        .font(.caption)
                }
                .buttonStyle(.plain)
            }

            if let method = denial.method, let path = denial.path {
                HStack(spacing: 6) {
                    Text("Operation:")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)
                    Text("\(method.uppercased()) /\(path)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.primary)
                }
            }

            if let expr = denial.expression {
                VStack(alignment: .leading, spacing: 2) {
                    Text(denial.line != nil ? "Denied by Rule (Line \(denial.line!)):" : "Denied by Rule:")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)
                    Text(expr)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.12))
                        .cornerRadius(6)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.red.opacity(0.3), lineWidth: 1)
                        )
                }
            }

            if !denial.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Evaluator Reasoning:")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)
                    Text(denial.reasons.joined(separator: "\n"))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.red)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.12))
                        .cornerRadius(6)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.1))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.red.opacity(0.4), lineWidth: 1)
                )
        )
    }

    private var addTodoBar: some View {
        HStack(spacing: 12) {
            TextField("What needs to be done?", text: $newTodoTitle)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    submitNewTodo()
                }

            Button {
                submitNewTodo()
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
            }
            .disabled(newTodoTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var todoListView: some View {
        List {
            Section(header: Text("Tasks for \(viewModel.effectiveUserId ?? "") (\(viewModel.todos.count))")) {
                ForEach(viewModel.todos) { todo in
                    TodoRowView(todo: todo) {
                        Task {
                            await viewModel.toggleTodo(item: todo)
                        }
                    }
                }
                .onDelete { indexSet in
                    viewModel.deleteTodos(at: indexSet)
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
    }

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "checklist")
                .font(.system(size: 64))
                .foregroundColor(.secondary)
            Text("No Todos Yet for This User")
                .font(.headline)
            Text("Add a task above or switch user with the Pyric Chip to see other users' tasks.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
    }

    private func submitNewTodo() {
        let title = newTodoTitle
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        newTodoTitle = ""
        Task {
            await viewModel.addTodo(title: title)
        }
    }
}

public struct TodoRowView: View {
    public let todo: TodoItem
    public let onToggle: () -> Void

    public init(todo: TodoItem, onToggle: @escaping () -> Void) {
        self.todo = todo
        self.onToggle = onToggle
    }

    public var body: some View {
        HStack(spacing: 12) {
            Button(action: onToggle) {
                Image(systemName: todo.completed ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(todo.completed ? .green : .secondary)
                    .font(.title3)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
                Text(todo.title)
                    .strikethrough(todo.completed)
                    .foregroundColor(todo.completed ? .secondary : .primary)
                    .font(.body)

                if let date = todo.createdAt?.dateValue() {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
