import XCTest
@testable import PyricFirestore

final class StorageDenialEmissionTests: XCTestCase {
    func testStorageUnauthorizedTriggersDenialYield() {
        XCTAssertTrue(
            PyricBridgeClient.shouldYieldDenial(
                wireCode: "storage/unauthorized",
                normalizedCode: .unknown,
                denialContext: nil
            )
        )
        XCTAssertTrue(
            PyricBridgeClient.shouldYieldDenial(
                wireCode: "unauthorized",
                normalizedCode: .unknown,
                denialContext: nil
            )
        )
    }

    func testFirestorePermissionDeniedAndDenialContextTriggerYield() {
        XCTAssertTrue(
            PyricBridgeClient.shouldYieldDenial(
                wireCode: "permission-denied",
                normalizedCode: .permissionDenied,
                denialContext: nil
            )
        )
        XCTAssertTrue(
            PyricBridgeClient.shouldYieldDenial(
                wireCode: "unknown",
                normalizedCode: .unknown,
                denialContext: .dictionary(["engine": .string("storage")])
            )
        )
    }

    func testUnrelatedErrorsWithoutDenialContextDoNotYield() {
        XCTAssertFalse(
            PyricBridgeClient.shouldYieldDenial(
                wireCode: "storage/object-not-found",
                normalizedCode: .unknown,
                denialContext: nil
            )
        )
    }
}
