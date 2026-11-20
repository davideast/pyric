// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "PyricIosRtdbOracle",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(
      name: "RtdbOracleCLI",
      targets: ["RtdbOracleCLI"]
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
    .executableTarget(
      name: "RtdbOracleCLI",
      dependencies: [
        .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
        .product(name: "FirebaseDatabase", package: "firebase-ios-sdk"),
      ],
      swiftLanguageModes: [.v5]
    ),
  ]
)
