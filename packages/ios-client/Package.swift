// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PyricDatabase",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "PyricDatabase",
            targets: ["PyricDatabase"]
        ),
    ],
    dependencies: [
        .package(path: "../swift-client")
    ],
    targets: [
        .target(
            name: "PyricDatabase",
            dependencies: [
                .product(name: "PyricFirestore", package: "swift-client"),
                .product(name: "FirebaseAuth", package: "swift-client")
            ],
            path: "Sources/PyricDatabase"
        ),
        .testTarget(
            name: "PyricDatabaseTests",
            dependencies: [
                "PyricDatabase",
                .product(name: "PyricFirestore", package: "swift-client"),
                .product(name: "FirebaseAuth", package: "swift-client")
            ],
            path: "Tests/PyricDatabaseTests"
        ),
    ]
)
