// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PyricFirestore",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "PyricFirestore",
            targets: ["PyricFirestore"]
        ),
        .library(
            name: "FirebaseAuth",
            targets: ["FirebaseAuth"]
        ),
        .library(
            name: "PyricDebugUI",
            targets: ["PyricDebugUI"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "PyricFirestore",
            dependencies: []
        ),
        .target(
            name: "FirebaseAuth",
            dependencies: ["PyricFirestore"]
        ),
        .target(
            name: "PyricDebugUI",
            dependencies: ["PyricFirestore", "FirebaseAuth"],
            path: "Sources/PyricDebugUI"
        ),
        .testTarget(
            name: "PyricFirestoreTests",
            dependencies: ["PyricFirestore", "FirebaseAuth"]
        ),
        .testTarget(
            name: "PyricAuthTests",
            dependencies: ["FirebaseAuth", "PyricFirestore"]
        ),
        .testTarget(
            name: "PyricDebugUITests",
            dependencies: ["PyricDebugUI", "PyricFirestore", "FirebaseAuth"],
            path: "Tests/PyricDebugUITests"
        ),
    ]
)

