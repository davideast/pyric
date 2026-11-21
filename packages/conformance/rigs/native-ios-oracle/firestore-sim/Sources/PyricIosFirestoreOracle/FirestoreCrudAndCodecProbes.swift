import FirebaseFirestore
import Foundation

extension FirestoreOracleProbeRunner {
  static func runCrudMergeSentinelsAndCodecs(
    db: Firestore,
    runId: String
  ) async throws -> [String: Any] {
    let col = db.collection("pyric_oracle/\(runId)/crud_items")
    let targetRef = col.document("ref-target")
    let alphaRef = col.document("alpha")
    var createdRefs: [DocumentReference] = [targetRef, alphaRef]

    do {
      try await targetRef.setData(["kind": "target"])

      let autoAddedRef = try await col.addDocument(data: ["origin": "auto-id", "seq": 1])
      createdRefs.append(autoAddedRef)
      let autoSnap = try await autoAddedRef.getDocument(source: .server)
      let autoIdLength = autoAddedRef.documentID.count
      let autoExists = autoSnap.exists
      let autoOrigin = autoSnap.data()?["origin"] as? String ?? ""

      let fixedTimestamp = Timestamp(seconds: 1_700_000_000, nanoseconds: 250_000_000)
      let fixedGeo = GeoPoint(latitude: 37.7749, longitude: -122.4194)
      let fixedBytes = Data([0x01, 0x02, 0x03, 0xFE])

      try await alphaRef.setData([
        "title": "Alpha",
        "count": 10,
        "ratio": 1.5,
        "active": true,
        "emptyVal": NSNull(),
        "tags": ["a", "b"],
        "nested": ["keep": "orig", "flag": true],
        "serverTs": FieldValue.serverTimestamp(),
        "fixedTs": fixedTimestamp,
        "geo": fixedGeo,
        "blob": fixedBytes,
        "ref": targetRef,
      ])

      let initialSnap = try await alphaRef.getDocument(source: .server)
      let initialData = initialSnap.data() ?? [:]
      let readTs = initialData["fixedTs"] as? Timestamp
      let readGeo = initialData["geo"] as? GeoPoint
      let readBlob = initialData["blob"] as? Data
      let readRef = initialData["ref"] as? DocumentReference

      let hasNullKey = initialData.keys.contains("emptyVal") && (initialData["emptyVal"] is NSNull)
      let serverTimestampResolved = initialData["serverTs"] is Timestamp
      let fixedTsMatches =
        readTs?.seconds == 1_700_000_000 && readTs?.nanoseconds == 250_000_000
      let geoMatches =
        abs((readGeo?.latitude ?? 0.0) - 37.7749) < 0.000001
        && abs((readGeo?.longitude ?? 0.0) - (-122.4194)) < 0.000001
      let blobBytes = readBlob.map { Array($0).map(Int.init) } ?? []
      let refMatchesTarget = readRef?.documentID == "ref-target"

      // Merge map preserves sibling top-level and nested fields.
      try await alphaRef.setData(
        [
          "title": "AlphaMerged",
          "nested": ["extra": 2],
        ],
        merge: true
      )
      let mergedSnap = try await alphaRef.getDocument(source: .server)
      let mergedData = mergedSnap.data() ?? [:]
      let mergedNested = mergedData["nested"] as? [String: Any] ?? [:]
      let mergePreservedCount = (mergedData["count"] as? NSNumber)?.intValue ?? -1
      let mergePreservedNestedKeep = mergedNested["keep"] as? String ?? ""
      let mergeAddedNestedExtra = (mergedNested["extra"] as? NSNumber)?.intValue ?? -1

      // mergeFields selectively applies listed paths while ignoring unlisted fields.
      try await alphaRef.setData(
        [
          "title": "AlphaSelected",
          "unlistedTop": "ignored",
          "nested": [
            "keep": "selected-keep",
            "unlistedNested": "ignored",
          ],
        ],
        mergeFields: ["title", FieldPath(["nested", "keep"])]
      )
      let mergeFieldsSnap = try await alphaRef.getDocument(source: .server)
      let mergeFieldsData = mergeFieldsSnap.data() ?? [:]
      let mergeFieldsNested = mergeFieldsData["nested"] as? [String: Any] ?? [:]
      let mergeFieldsTitle = mergeFieldsData["title"] as? String ?? ""
      let mergeFieldsUnlistedTopAbsent = mergeFieldsData["unlistedTop"] == nil
      let mergeFieldsNestedKeep = mergeFieldsNested["keep"] as? String ?? ""
      let mergeFieldsPreservedExtra = (mergeFieldsNested["extra"] as? NSNumber)?.intValue ?? -1
      let mergeFieldsUnlistedNestedAbsent = mergeFieldsNested["unlistedNested"] == nil

      // updateData with FieldValue.increment, arrayUnion, arrayRemove, and delete.
      try await alphaRef.updateData([
        "count": FieldValue.increment(Int64(5)),
        "ratio": FieldValue.increment(2.25),
        "tags": FieldValue.arrayUnion(["c", "a"]),
        "nested.extra": FieldValue.delete(),
      ])
      try await alphaRef.updateData([
        "tags": FieldValue.arrayRemove(["b"]),
      ])

      let updatedSnap = try await alphaRef.getDocument(source: .server)
      let updatedData = updatedSnap.data() ?? [:]
      let updatedNested = updatedData["nested"] as? [String: Any] ?? [:]
      let incrementedCount = (updatedData["count"] as? NSNumber)?.intValue ?? -1
      let incrementedRatio = (updatedData["ratio"] as? NSNumber)?.doubleValue ?? -1.0
      let finalTags = updatedData["tags"] as? [String] ?? []
      let deletedNestedExtraAbsent = updatedNested["extra"] == nil

      // Delete document and confirm server absence.
      try await alphaRef.delete()
      let deletedSnap = try await alphaRef.getDocument(source: .server)
      let deletedExists = deletedSnap.exists
      let deletedDataIsNil = deletedSnap.data() == nil

      await deleteDocsBestEffort(createdRefs)

      return [
        "autoIdLength": autoIdLength,
        "autoExists": autoExists,
        "autoOrigin": autoOrigin,
        "initialExists": initialSnap.exists,
        "initialFromCache": initialSnap.metadata.isFromCache,
        "initialHasPendingWrites": initialSnap.metadata.hasPendingWrites,
        "hasNullKey": hasNullKey,
        "serverTimestampResolved": serverTimestampResolved,
        "fixedTsMatches": fixedTsMatches,
        "geoMatches": geoMatches,
        "blobBytes": blobBytes,
        "refMatchesTarget": refMatchesTarget,
        "mergePreservedCount": mergePreservedCount,
        "mergePreservedNestedKeep": mergePreservedNestedKeep,
        "mergeAddedNestedExtra": mergeAddedNestedExtra,
        "mergeFieldsTitle": mergeFieldsTitle,
        "mergeFieldsUnlistedTopAbsent": mergeFieldsUnlistedTopAbsent,
        "mergeFieldsNestedKeep": mergeFieldsNestedKeep,
        "mergeFieldsPreservedExtra": mergeFieldsPreservedExtra,
        "mergeFieldsUnlistedNestedAbsent": mergeFieldsUnlistedNestedAbsent,
        "incrementedCount": incrementedCount,
        "incrementedRatio": incrementedRatio,
        "finalTags": finalTags,
        "deletedNestedExtraAbsent": deletedNestedExtraAbsent,
        "deletedExists": deletedExists,
        "deletedDataIsNil": deletedDataIsNil,
      ]
    } catch {
      await deleteDocsBestEffort(createdRefs)
      throw error
    }
  }
}
