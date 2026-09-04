import Foundation
import SwiftUI
import PyricFirestore

/// Bottom sheet modal containing the Identity Switcher and Security Rules Denial Diagnostics.
public struct PyricDebugSheetView: View {
    @ObservedObject public var manager: PyricDebugManager
    @State private var searchText: String = ""

    public init(manager: PyricDebugManager = .shared) {
        self.manager = manager
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Segmented Tab Picker
                Picker("Tab", selection: $manager.selectedTab) {
                    Text("Identity").tag(0)
                    HStack {
                        Text("Rules Denials")
                        if !manager.recentDenials.isEmpty {
                            Text("(\(manager.recentDenials.count))")
                                .foregroundColor(.red)
                        }
                    }
                    .tag(1)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)

                if manager.selectedTab == 0 {
                    identityView
                } else {
                    denialsView
                }
            }
            .navigationTitle("Pyric Companion")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        manager.isPresented = false
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    if manager.selectedTab == 0 {
                        Button {
                            Task { await manager.refreshUsers() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(manager.isLoadingUsers)
                    } else if !manager.recentDenials.isEmpty {
                        Button("Clear") {
                            manager.clearDenials()
                        }
                    }
                }
            }
            .task {
                if manager.users.isEmpty {
                    await manager.refreshUsers()
                }
            }
        }
    }

    // ─── Identity & Impersonation Tab ────────────────────────────────────────

    private var identityView: some View {
        List {
            // Admin Bypass Section
            Section {
                Toggle(isOn: Binding(
                    get: { manager.isAdminBypass },
                    set: { manager.toggleAdminBypass($0) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text("Admin Bypass")
                                .font(.headline)
                            Image(systemName: "shield.fill")
                                .foregroundColor(.purple)
                        }
                        Text("Bypasses all Firestore Security Rules")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .tint(.purple)
            }

            // Quick Switching Modes
            Section(header: Text("Quick Modes")) {
                Button(action: { manager.selectAnon() }) {
                    HStack {
                        Label("Anonymous", systemImage: "person.slash")
                        Spacer()
                        if manager.activeLens == .anon {
                            Image(systemName: "checkmark")
                                .foregroundColor(.accentColor)
                        }
                    }
                }

                Button(action: { manager.selectAppSession() }) {
                    HStack {
                        Label("App Session (Mirror Browser)", systemImage: "desktopcomputer")
                        Spacer()
                        if manager.activeLens == .appSession {
                            Image(systemName: "checkmark")
                                .foregroundColor(.accentColor)
                        }
                    }
                }
            }

            // Sandbox Users Directory
            Section(header: Text("Sandbox Users (\(filteredUsers.count))")) {
                if manager.isLoadingUsers && manager.users.isEmpty {
                    HStack {
                        Spacer()
                        ProgressView("Loading users...")
                        Spacer()
                    }
                    .padding(.vertical, 8)
                } else if filteredUsers.isEmpty {
                    Text(manager.users.isEmpty ? "No sandbox users found. Create one in Pyric Studio." : "No users match '\(searchText)'.")
                        .foregroundColor(.secondary)
                        .font(.caption)
                } else {
                    ForEach(filteredUsers) { user in
                        userRow(user)
                    }
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search by email, name, or UID")
    }

    private var filteredUsers: [SandboxUserRecord] {
        if searchText.isEmpty {
            return manager.users
        }
        return manager.users.filter { user in
            (user.email?.localizedCaseInsensitiveContains(searchText) ?? false) ||
            (user.displayName?.localizedCaseInsensitiveContains(searchText) ?? false) ||
            user.uid.localizedCaseInsensitiveContains(searchText)
        }
    }

    private func userRow(_ user: SandboxUserRecord) -> some View {
        let isSelected: Bool = {
            if case .asUser(let uid, _, _) = manager.activeLens {
                return uid == user.uid
            }
            return false
        }()

        return Button(action: {
            manager.selectUser(user)
        }) {
            HStack(spacing: 12) {
                // Avatar circle
                Circle()
                    .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.2))
                    .frame(width: 38, height: 38)
                    .overlay(
                        Text(userInitials(user))
                            .font(.subheadline.bold())
                            .foregroundColor(isSelected ? .white : .primary)
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text(user.displayName ?? user.email ?? user.uid)
                        .font(.subheadline.bold())
                        .foregroundColor(.primary)

                    if let email = user.email, user.displayName != nil {
                        Text(email)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    HStack(spacing: 4) {
                        Text(user.uid)
                            .font(.caption2.monospaced())
                            .foregroundColor(.secondary)

                        if let tenant = user.tenantId, !tenant.isEmpty {
                            Text("• \(tenant)")
                                .font(.caption2)
                                .foregroundColor(.purple)
                        }
                    }

                    // Claims chips
                    if !user.customClaims.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(Array(user.customClaims.prefix(3)), id: \.key) { key, val in
                                Text("\(key): \(val.description)")
                                    .font(.system(size: 9))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 2)
                                    .background(Color.blue.opacity(0.1))
                                    .cornerRadius(3)
                            }
                        }
                    }
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func userInitials(_ user: SandboxUserRecord) -> String {
        if let name = user.displayName, let first = name.first {
            return String(first).uppercased()
        }
        if let email = user.email, let first = email.first {
            return String(first).uppercased()
        }
        return String(user.uid.prefix(2)).uppercased()
    }

    // ─── Rules Denials Tab ───────────────────────────────────────────────────

    private var denialsView: some View {
        Group {
            if manager.recentDenials.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "checkmark.shield.fill")
                        .font(.system(size: 48))
                        .foregroundColor(.green)
                    Text("Zero Rules Denials")
                        .font(.headline)
                    Text("All Firestore operations evaluated cleanly against security rules.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Spacer()
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(manager.recentDenials) { report in
                            RulesDenialCardView(report: report, manager: manager)
                        }
                    }
                    .padding()
                }
            }
        }
    }
}
