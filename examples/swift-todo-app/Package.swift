// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SwiftTodoApp",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .executable(
            name: "SwiftTodoApp",
            targets: ["SwiftTodoApp"]
        )
    ],
    dependencies: [
        .package(path: "../../packages/swift-client"),
        .package(path: "../../packages/ios-client")
    ],
    targets: [
        .executableTarget(
            name: "SwiftTodoApp",
            dependencies: [
                .product(name: "PyricFirestore", package: "swift-client"),
                .product(name: "FirebaseAuth", package: "swift-client"),
                .product(name: "PyricDebugUI", package: "swift-client"),
                .product(name: "PyricDatabase", package: "ios-client")
            ],
            path: "Sources"
        )
    ]
)
