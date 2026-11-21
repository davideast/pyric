// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "PyricIosFirestoreOracle",
  platforms: [
    .iOS(.v16),
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "PyricIosFirestoreOracle",
      targets: ["PyricIosFirestoreOracle"]
    ),
  ],
  dependencies: [
    .package(
      url: "https://github.com/firebase/firebase-ios-sdk.git",
      exact: "13.2.0",
      traits: ["Firestore"]
    ),
  ],
  targets: [
    .target(
      name: "PyricIosFirestoreOracle",
      dependencies: [
        .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
        .product(name: "FirebaseAuth", package: "firebase-ios-sdk"),
        .product(name: "FirebaseFirestore", package: "firebase-ios-sdk"),
      ],
      swiftLanguageModes: [.v5]
    ),
    .testTarget(
      name: "FirestoreOracleSimTests",
      dependencies: ["PyricIosFirestoreOracle"],
      resources: [
        .copy("Resources/oracle-input.json"),
      ],
      swiftLanguageModes: [.v5]
    ),
  ]
)
