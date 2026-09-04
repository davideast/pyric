import SwiftUI
import PyricFirestore

@main
struct SwiftTodoApp: App {
    @StateObject private var viewModel = TodoListViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
                .task {
                    if ProcessInfo.processInfo.arguments.contains("-demoSecurityRulesError") {
                        // Wait for WebSocket bridge connection to establish, then trigger unauthorized write
                        try? await Task.sleep(nanoseconds: 1_200_000_000)
                        await viewModel.addTodo(title: "Unauthorized Client Write")
                    }
                }
        }
    }
}
