import Foundation
import Testing
@testable import PyricFunctions
import FirebaseAuth
import PyricFirestore

@Suite("Functions Phase 2 Parity Regression Suite", .serialized)
struct FunctionsPhase2ParityRegressionTests {
    @Test("P2-K14 / P2-F07c: non-2xx response with error.status OK is not downgraded to nil")
    func non2xxOkStatusNotDowngraded() throws {
        let body = try #require(#"{"error":{"status":"OK","message":"spoofed"},"data":"ok"}"#.data(using: .utf8))
        let err = FunctionsError.fromResponse(
            httpStatusCode: 500,
            region: "us-central1",
            url: URL(string: "http://127.0.0.1:5174/demo")!,
            body: body,
            serializer: FunctionsSerializer()
        )
        let unwrapped = try #require(err)
        #expect(unwrapped.code == .internal)
    }

    @Test("P2-S10b: resolveContext does not eagerly initialize Auth and omits token under anon or mismatched lens")
    func resolveContextRespectsAuthLensAndAvoidsEagerAuth() async {
        let app = FirebaseApp(
            name: "fn-s10b-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "fn-s10b", apiKey: "k", googleAppID: "1:1:ios:abc")
        )
        #expect(Auth.existingInstance(app: app) == nil)
        let ctx = await FunctionsContextProvider.resolveContext(
            app: app,
            requireLimitedUseAppCheckTokens: false
        )
        #expect(ctx.authIDToken == nil)
        #expect(Auth.existingInstance(app: app) == nil)

        let auth = Auth.auth(app: app)
        auth.switchLens(.anon)
        let anonCtx = await FunctionsContextProvider.resolveContext(
            app: app,
            requireLimitedUseAppCheckTokens: false
        )
        #expect(anonCtx.authIDToken == nil)
    }
}
