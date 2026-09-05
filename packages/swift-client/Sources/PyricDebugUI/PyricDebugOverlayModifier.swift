import Foundation
import SwiftUI

/// ViewModifier that overlays the Pyric debug pill onto any view hierarchy.
public struct PyricDebugOverlayModifier: ViewModifier {
    @ObservedObject public var manager: PyricDebugManager

    public init(manager: PyricDebugManager = .shared) {
        self.manager = manager
    }

    public func body(content: Content) -> some View {
        content
            .overlay(alignment: .topLeading) {
                PyricDebugPillView(manager: manager)
            }
            .sheet(isPresented: $manager.isPresented) {
                PyricDebugSheetView(manager: manager)
            }
    }
}

extension View {
    /// Attaches the floating Pyric companion pill to this view.
    public func pyricDebugOverlay(manager: PyricDebugManager = .shared) -> some View {
        modifier(PyricDebugOverlayModifier(manager: manager))
    }
}
