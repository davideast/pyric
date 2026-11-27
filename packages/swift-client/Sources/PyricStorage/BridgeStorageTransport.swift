import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

/// Package-internal Storage RPC and HTTP byte-route transport over `PyricBridgeClient`.
///
/// Byte uploads and downloads execute through `StorageUploadTask` and `StorageDownloadTask`;
/// this namespace owns metadata, download-URL, deletion, listing, and shared HTTP helpers.
package enum BridgeStorageTransport {
    package static let maxStorageOpBytes: Int = 8 * 1024 * 1024
    package static let maxStoragePartBytes: Int = 4 * 1024 * 1024
    package static let maxStorageObjectBytes: Int64 = 512 * 1024 * 1024

    // MARK: - Metadata, Download URL, Delete, List

    package static func getDownloadURL(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws -> URL {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: downloadURL cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.getDownloadURL",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        guard let rawPath = res.dictionaryValue?["path"]?.stringValue, !rawPath.isEmpty else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.getDownloadURL did not return a non-empty path."
            )
        }
        if rawPath.hasPrefix("http://") || rawPath.hasPrefix("https://") || rawPath.hasPrefix("data:") {
            guard let direct = URL(string: rawPath) else {
                throw StorageErrorCode(code: .internalError, message: "Malformed download URL: \(rawPath)")
            }
            return direct
        }
        let clientEndpoint = await client.endpoint
        guard let resolved = resolveByteRouteURL(endpoint: clientEndpoint, relativePath: rawPath) else {
            throw StorageErrorCode(code: .internalError, message: "Unable to resolve download URL path: \(rawPath)")
        }
        return resolved
    }

    package static func getMetadata(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: getMetadata cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.getMetadata",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        return try StorageMetadata.fromWire(res, fallbackBucket: reference.bucket)
    }

    package static func updateMetadata(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        metadata: StorageMetadata,
        timeout: TimeInterval
    ) async throws -> StorageMetadata {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: updateMetadata cannot operate on the root reference."
            )
        }

        let clientPatch = metadata.toAdminPatchWire(existingCustomKeys: [])
        var clientParams = reference.bucketWireParams
        clientParams["path"] = .string(reference.fullPath)
        clientParams["patch"] = .dictionary(clientPatch)
        if metadata.replacesCustomMetadata {
            clientParams["replaceCustomMetadata"] = .bool(true)
        }
        do {
            let updated = try await client.op(
                turn: turn,
                method: "storage.updateMetadata",
                params: clientParams,
                actAs: actAs,
                timeout: timeout
            )
            return try StorageMetadata.fromWire(updated, fallbackBucket: reference.bucket)
        } catch let bridgeErr as PyricBridgeError {
            let msg = bridgeErr.message.lowercased()
            let code = bridgeErr.rawCode.lowercased()
            let unsupportedOp = bridgeErr.code == .unimplemented
                || code == "unimplemented"
                || msg.contains("unknown method")
                || msg.contains("unknown op")
                || msg.contains("unsupported")
            if !unsupportedOp {
                throw bridgeErr
            }
        }

        if client.hasInjectedChannel {
            var params = reference.bucketWireParams
            params["path"] = .string(reference.fullPath)
            params["patch"] = .dictionary(clientPatch)
            do {
                let direct = try await client.op(
                    method: "storage.setMetadata",
                    params: params,
                    actAs: actAs,
                    timeout: timeout
                )
                return try StorageMetadata.fromWire(direct, fallbackBucket: reference.bucket)
            } catch let bridgeErr as PyricBridgeError where bridgeErr.message.contains("admin plane") {
                return try await updateMetadataWithRulesGate(
                    reference: reference,
                    client: client,
                    turn: nil,
                    actAs: actAs,
                    metadata: metadata,
                    timeout: timeout
                )
            }
        }

        return try await updateMetadataWithRulesGate(
            reference: reference,
            client: client,
            turn: nil,
            actAs: actAs,
            metadata: metadata,
            timeout: timeout
        )
    }

    package static func deleteObject(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        timeout: TimeInterval
    ) async throws {
        if reference.fullPath.isEmpty {
            await client.pass(turn: turn)
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "storage/invalid-root-operation: delete cannot operate on the root reference."
            )
        }
        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        _ = try await client.op(
            turn: turn,
            method: "storage.deleteObject",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
    }

    package static func list(
        reference: StorageReference,
        client: PyricBridgeClient,
        turn: OperationTurn,
        actAs: AuthLens?,
        maxResults: Int64?,
        pageToken: String?,
        timeout: TimeInterval
    ) async throws -> StorageListResult {
        do {
            try StorageListPaginator.validateArguments(maxResults: maxResults, pageToken: pageToken)
        } catch {
            await client.pass(turn: turn)
            throw error
        }

        var params = reference.bucketWireParams
        params["path"] = .string(reference.fullPath)
        let res = try await client.op(
            turn: turn,
            method: "storage.listAll",
            params: params,
            actAs: actAs,
            timeout: timeout
        )
        guard let dict = res.dictionaryValue else {
            throw StorageErrorCode(
                code: .internalError,
                message: "storage.listAll response from Pyric bridge was not an object."
            )
        }

        let allPrefixes = decodeListReferences(dict["prefixes"]?.arrayValue, parent: reference)
        let allItems = decodeListReferences(dict["items"]?.arrayValue, parent: reference)

        return try StorageListPaginator.paginate(
            prefixes: allPrefixes,
            items: allItems,
            maxResults: maxResults,
            pageToken: pageToken
        )
    }
}
