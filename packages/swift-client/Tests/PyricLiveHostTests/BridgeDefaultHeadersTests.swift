import Foundation
import XCTest
@testable import PyricFirestore

final class BridgeDefaultHeadersTests: XCTestCase {
    func testDefaultEndpointUsesDefaultHostHeader() async {
        let client = PyricBridgeClient()
        let headers = await client.headers
        XCTAssertEqual(headers, ["Host": "127.0.0.1:5174"])
    }

    func testCustomEndpointDerivesHostAndPort() async {
        let endpoint = URL(string: "ws://127.0.0.1:3475/__pyric/sandbox")!
        let client = PyricBridgeClient(endpoint: endpoint)
        let headers = await client.headers
        XCTAssertEqual(headers, ["Host": "127.0.0.1:3475"])
    }

    func testIPv6EndpointBracketsHostLiteral() async {
        let endpoint = URL(string: "ws://[::1]:3473/__pyric/sandbox")!
        let client = PyricBridgeClient(endpoint: endpoint)
        let headers = await client.headers
        XCTAssertEqual(headers, ["Host": "[::1]:3473"])
    }

    func testExplicitHeadersOverrideDefault() async {
        let endpoint = URL(string: "ws://127.0.0.1:3475/__pyric/sandbox")!
        let custom = ["Host": "custom.local:9000", "X-Test": "1"]
        let client = PyricBridgeClient(endpoint: endpoint, headers: custom)
        let headers = await client.headers
        XCTAssertEqual(headers, custom)
    }

    func testMakeWebSocketRequestPopulatesHostFromCustomURL() {
        let endpoint = URL(string: "ws://127.0.0.1:3475/__pyric/sandbox")!
        let request = PyricBridgeClient.makeWebSocketRequest(url: endpoint)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Host"), "127.0.0.1:3475")
    }
}
