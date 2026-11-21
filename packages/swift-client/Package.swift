// swift-tools-version: 6.0
import PackageDescription

var products: [Product] = [
    .library(
        name: "PyricFirestore",
        targets: ["PyricFirestore"]
    ),
    .library(
        name: "FirebaseAuth",
        targets: ["FirebaseAuth"]
    ),
    .library(
        name: "PyricDatabase",
        targets: ["PyricDatabase"]
    ),
    .library(
        name: "PyricAppCheck",
        targets: ["PyricAppCheck"]
    ),
]

var targets: [Target] = [
    .target(
        name: "PyricFirestore",
        dependencies: []
    ),
    .target(
        name: "FirebaseAuth",
        dependencies: ["PyricFirestore"]
    ),
    .target(
        name: "PyricDatabase",
        dependencies: ["PyricFirestore", "FirebaseAuth"],
        path: "Sources/PyricDatabase"
    ),
    .target(
        name: "PyricAppCheck",
        dependencies: ["PyricFirestore"],
        path: "Sources/PyricAppCheck"
    ),
    .testTarget(
        name: "PyricLiveHostTests",
        dependencies: ["PyricFirestore", "FirebaseAuth", "PyricDatabase"],
        path: "Tests/PyricLiveHostTests"
    ),
    .testTarget(
        name: "PyricAppCheckTests",
        dependencies: ["PyricAppCheck", "PyricFirestore", "FirebaseAuth", "PyricDatabase"],
        path: "Tests/PyricAppCheckTests"
    ),
]

#if !os(Linux)
products.append(
    .library(
        name: "PyricDebugUI",
        targets: ["PyricDebugUI"]
    )
)
targets.append(contentsOf: [
    .target(
        name: "PyricDebugUI",
        dependencies: ["PyricFirestore", "FirebaseAuth"],
        path: "Sources/PyricDebugUI"
    ),
    .testTarget(
        name: "PyricFirestoreTests",
        // PyricDatabase lets the reconnect tests drive `.info/connected`
        // on the fake reconnecting bridge kept in this target.
        dependencies: ["PyricFirestore", "FirebaseAuth", "PyricDatabase"]
    ),
    .testTarget(
        name: "PyricAuthTests",
        dependencies: ["FirebaseAuth", "PyricFirestore"]
    ),
    .testTarget(
        name: "PyricDatabaseTests",
        dependencies: ["PyricDatabase", "PyricFirestore", "FirebaseAuth"],
        path: "Tests/PyricDatabaseTests"
    ),
    .testTarget(
        name: "PyricDebugUITests",
        dependencies: ["PyricDebugUI", "PyricFirestore", "FirebaseAuth"],
        path: "Tests/PyricDebugUITests",
        // Captured wire envelopes, read from disk by path.
        exclude: ["Fixtures"]
    ),
])
#endif

let package = Package(
    name: "PyricFirestore",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: products,
    dependencies: [],
    targets: targets
)
