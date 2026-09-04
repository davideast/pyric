import Foundation
import SwiftUI
import PyricFirestore

/// A floating, draggable pill overlay displaying active identity and denial status.
public struct PyricDebugPillView: View {
    @ObservedObject public var manager: PyricDebugManager

    @State private var offset: CGSize = CGSize(width: 16, height: 80)
    @State private var dragTranslation: CGSize = .zero

    public init(manager: PyricDebugManager = .shared) {
        self.manager = manager
    }

    public var body: some View {
        pillBody
            .contentShape(Capsule())
            .highPriorityGesture(
                TapGesture().onEnded {
                    manager.isPresented = true
                }
            )
            .gesture(
                DragGesture(minimumDistance: 5)
                    .onChanged { value in
                        dragTranslation = value.translation
                    }
                    .onEnded { value in
                        offset.width += value.translation.width
                        offset.height += value.translation.height
                        dragTranslation = .zero
                    }
            )
            .padding(.leading, max(10, offset.width + dragTranslation.width))
            .padding(.top, max(10, offset.height + dragTranslation.height))
    }

    private var pillBody: some View {
        HStack(spacing: 6) {
            // Pyric brand / status icon
            Image(systemName: iconName)
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(iconColor)

            // Identity label
            Text(manager.activeIdentityTitle)
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .lineLimit(1)
                .foregroundColor(.white)

            // Denial badge counter
            if !manager.recentDenials.isEmpty {
                Text("\(manager.recentDenials.count)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.red)
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            Capsule()
                .fill(pillBackgroundColor)
                .shadow(color: Color.black.opacity(0.3), radius: 6, x: 0, y: 3)
        )
        .overlay(
            Capsule()
                .stroke(pillBorderColor, lineWidth: 1.5)
        )
        .contentShape(Capsule())
    }

    private var iconName: String {
        switch manager.activeLens {
        case .admin:
            return "shield.fill"
        case .anon:
            return "person.slash.fill"
        case .appSession:
            return "desktopcomputer"
        case .custom:
            return "slider.horizontal.3"
        case .asUser:
            return "person.crop.circle.fill"
        }
    }

    private var iconColor: Color {
        switch manager.activeLens {
        case .admin:
            return .purple
        case .anon:
            return .gray
        case .appSession:
            return .blue
        case .custom:
            return .orange
        case .asUser:
            return .green
        }
    }

    private var pillBackgroundColor: Color {
        Color(white: 0.12).opacity(0.92)
    }

    private var pillBorderColor: Color {
        if !manager.recentDenials.isEmpty {
            return Color.red.opacity(0.8)
        }
        if manager.isAdminBypass {
            return Color.purple.opacity(0.8)
        }
        return Color.white.opacity(0.18)
    }
}
