// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "PyricIosAuthOracle",
  platforms: [
    .iOS(.v16),
    .macOS(.v13),
  ],
  products: [
    .library(
      name: "PyricIosAuthOracle",
      targets: ["PyricIosAuthOracle"]
    ),
  ],
  dependencies: [
    .package(
      url: "https://github.com/firebase/firebase-ios-sdk.git",
      exact: "13.2.0",
      traits: []
    ),
  ],
  targets: [
    .target(
      name: "PyricIosAuthOracle",
      dependencies: [
        .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
        .product(name: "FirebaseAuth", package: "firebase-ios-sdk"),
      ],
      swiftSettings: [
        .swiftLanguageMode(.v5),
      ]
    ),
    .testTarget(
      name: "AuthOracleSimTests",
      dependencies: ["PyricIosAuthOracle"],
      resources: [
        .copy("Resources/oracle-input.json"),
      ],
      swiftSettings: [
        .swiftLanguageMode(.v5),
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
