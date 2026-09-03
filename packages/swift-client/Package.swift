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
    ],
    dependencies: [],
    targets: [
        .target(
            name: "PyricFirestore",
            dependencies: []
        ),
        .testTarget(
            name: "PyricFirestoreTests",
            dependencies: ["PyricFirestore"]
        ),
    ]
)
