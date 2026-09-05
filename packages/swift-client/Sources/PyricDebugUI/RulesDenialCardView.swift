import Foundation
import SwiftUI
import PyricFirestore

/// A diagnostic card rendering a Security Rules evaluation failure (CEL rejection).
public struct RulesDenialCardView: View {
    public let report: RulesDenialReport
    @ObservedObject public var manager: PyricDebugManager

    @State private var isExpanded: Bool = false

    public init(report: RulesDenialReport, manager: PyricDebugManager = .shared) {
        self.report = report
        self.manager = manager
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: Warning badge + citation
            HStack {
                Label("PERMISSION_DENIED", systemImage: "shield.slash.fill")
                    .font(.caption.bold())
                    .foregroundColor(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.red.opacity(0.12))
                    .cornerRadius(6)

                Spacer()

                Text(report.citation)
                    .font(.caption.monospaced())
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.1))
                    .cornerRadius(4)
            }

            // Failing CEL expression snippet
            if let expression = report.expression, !expression.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("RULE EXPRESSION")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)

                    Text(expression)
                        .font(.system(.caption, design: .monospaced))
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.black.opacity(0.06))
                        .cornerRadius(6)
                }
            }

            // Evaluation reasons
            if !report.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("EVALUATION REASONS")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)

                    ForEach(report.reasons, id: \.self) { reason in
                        HStack(alignment: .top, spacing: 6) {
                            Text("•").foregroundColor(.red)
                            Text(reason)
                                .font(.caption)
                                .foregroundColor(.primary)
                        }
                    }
                }
            }

            // Collapsible details accordion
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    if let method = report.requestMethod, let path = report.requestPath {
                        detailRow(title: "Operation", value: "\(method.uppercased()) \(path)")
                    } else if let path = report.requestPath {
                        detailRow(title: "Path", value: path)
                    }

                    if let authUid = report.authUid {
                        detailRow(title: "Auth UID", value: authUid)
                    }
                    if let tenant = report.authTenant {
                        detailRow(title: "Tenant", value: tenant)
                    }
                    if !report.failedFields.isEmpty {
                        detailRow(title: "Failed Fields", value: report.failedFields.joined(separator: ", "))
                    }

                    if let proposed = report.proposedData, !proposed.isEmpty {
                        dataBlock(title: "Proposed Data (request.resource.data)", dict: proposed)
                    }
                    if let existing = report.existingData, !existing.isEmpty {
                        dataBlock(title: "Existing Data (resource.data)", dict: existing)
                    }
                }
                .padding(.top, 4)
            } label: {
                Text(isExpanded ? "Hide Evaluation Context" : "View Evaluation Context")
                    .font(.caption.bold())
                    .foregroundColor(.accentColor)
            }

            // Quick actions footer
            Divider().padding(.vertical, 2)

            HStack {
                Button(action: {
                    manager.toggleAdminBypass(true)
                }) {
                    Label("1-Tap Admin Bypass", systemImage: "shield.fill")
                        .font(.caption.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)

                Spacer()

                if let authUid = report.authUid, !authUid.isEmpty {
                    Button(action: {
                        let userRecord = SandboxUserRecord(
                            uid: authUid,
                            tenantId: report.authTenant,
                            customClaims: report.authClaims ?? [:]
                        )
                        manager.selectUser(userRecord)
                    }) {
                        Label("Impersonate \(authUid)", systemImage: "person.crop.circle.badge.checkmark")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .padding(14)
        .background(Color.secondary.opacity(0.12))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.red.opacity(0.3), lineWidth: 1)
        )
    }

    private func detailRow(title: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(title + ":")
                .font(.caption2.bold())
                .foregroundColor(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.caption.monospaced())
                .foregroundColor(.primary)
            Spacer()
        }
    }

    private func dataBlock(title: String, dict: [String: AnySendable]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2.bold())
                .foregroundColor(.secondary)
            let formatted = dict.map { "\($0.key): \($0.value.description)" }.joined(separator: "\n")
            Text(formatted)
                .font(.system(.caption2, design: .monospaced))
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.04))
                .cornerRadius(4)
        }
    }
}
