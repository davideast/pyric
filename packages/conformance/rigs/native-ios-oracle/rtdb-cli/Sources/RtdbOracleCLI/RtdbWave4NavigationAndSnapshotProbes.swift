import FirebaseCore
import FirebaseDatabase
import Foundation

func setPriorityAsync(_ ref: DatabaseReference, priority: Any?) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.setPriority(priority) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

func setValueWithPriorityAsync(
  _ ref: DatabaseReference,
  value: Any?,
  priority: Any?
) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    ref.setValue(value, andPriority: priority) { error, _ in
      if let error = error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

private func describeSnapshotValueKind(_ raw: Any?) -> String {
  guard let unwrapped = raw else {
    return "nil"
  }
  if unwrapped is NSNull {
    return "NSNull"
  }
  if let number = unwrapped as? NSNumber {
    if type(of: number) === type(of: NSNumber(value: true)) {
      return "Bool"
    }
    return "NSNumber"
  }
  if unwrapped is String {
    return "String"
  }
  if unwrapped is [Any] {
    return "Array"
  }
  if unwrapped is [String: Any] {
    return "Dictionary"
  }
  return "Other"
}

private func collectChildKeys(_ snapshot: DataSnapshot) -> [String] {
  var keys: [String] = []
  for case let child as DataSnapshot in snapshot.children {
    keys.append(child.key)
  }
  return keys
}

private func collectChildStrings(_ snapshot: DataSnapshot) -> [String] {
  var values: [String] = []
  for case let child as DataSnapshot in snapshot.children {
    if let strVal = child.value as? String {
      values.append(strVal)
    }
  }
  return values
}

func runNavigationPushPrioritiesAndSnapshots(
  db: Database,
  config: RtdbOracleConfig
) async throws -> [String: Any] {
  let trimmedDbUrl = config.databaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let createdDefaultApp = FirebaseApp.app() == nil
  if createdDefaultApp {
    let defaultOptions = makeRtdbFirebaseOptions(config: config)
    FirebaseApp.configure(options: defaultOptions)
  }

  var defaultDbRef: Database?
  var urlDbRef: Database?
  let defaultInstanceIdentical: Bool
  let defaultRootMatchesDatabaseUrl: Bool
  let urlInstanceIdentical: Bool
  if FirebaseApp.app() != nil {
    let defaultDb = Database.database()
    defaultDbRef = defaultDb
    defaultInstanceIdentical = defaultDb === Database.database()
    defaultRootMatchesDatabaseUrl =
      defaultDb.reference().url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      == trimmedDbUrl

    let urlDb = Database.database(url: config.databaseUrl)
    urlDbRef = urlDb
    urlInstanceIdentical = urlDb === Database.database(url: config.databaseUrl)

    if defaultDb !== db {
      defaultDb.goOffline()
    }
    if urlDb !== db && urlDb !== defaultDb {
      urlDb.goOffline()
    }
  } else {
    defaultInstanceIdentical = false
    defaultRootMatchesDatabaseUrl = false
    urlInstanceIdentical = false
  }

  db.goOnline()
  let runRef = db.reference(withPath: "pyric_oracle/\(config.runId)")

  do {
    let namedAppMatches = db.app != nil
    let namedDatabaseIdentical: Bool
    if let dbApp = db.app {
      namedDatabaseIdentical = Database.database(app: dbApp, url: config.databaseUrl) === db
    } else {
      namedDatabaseIdentical = false
    }

    let rootRef = db.reference()
    let rootKeyIsNil = rootRef.key == nil
    let rootParentIsNil = rootRef.parent == nil
    let rootSelfUrlMatches = rootRef.root.url == rootRef.url
    let rootUrlMatchesDatabaseUrl =
      rootRef.url.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == trimmedDbUrl

    let nestedLeaf = runRef.child("nav/section/leaf_node")
    let nestedKey = nestedLeaf.key ?? ""
    let nestedParentKey = nestedLeaf.parent?.key ?? ""
    let nestedGrandParentKey = nestedLeaf.parent?.parent?.key ?? ""
    let nestedRootKeyIsNil = nestedLeaf.root.key == nil
    let nestedRootUrlMatchesRoot = nestedLeaf.root.url == rootRef.url
    let nestedUrlSuffixMatches = nestedLeaf.url.hasSuffix("/nav/section/leaf_node")
    let nestedDescriptionSuffixMatches =
      nestedLeaf.description().hasSuffix("/nav/section/leaf_node")
    let fromUrlRef = db.reference(fromURL: nestedLeaf.url)
    let fromUrlMatchesKeyAndUrl =
      fromUrlRef.key == "leaf_node" && fromUrlRef.url == nestedLeaf.url

    let pushGroup = runRef.child("pushed_items")
    let push1 = pushGroup.childByAutoId()
    let push2 = pushGroup.childByAutoId()
    let push3 = pushGroup.childByAutoId()
    let k1 = push1.key ?? ""
    let k2 = push2.key ?? ""
    let k3 = push3.key ?? ""
    let pushKeyLength = k1.count
    let pushKeysLexicographicallyMonotonic =
      k1.count == 20 && k2.count == 20 && k3.count == 20 && k1 < k2 && k2 < k3

    try await setValueAsync(push1, value: "first")
    try await setValueAsync(push2, value: "second")
    try await setValueAsync(push3, value: "third")
    let pushOrderedSnap = try await getDataAsync(pushGroup.queryOrderedByKey())
    let pushOrderedValues = collectChildStrings(pushOrderedSnap)

    let typesRef = runRef.child("value_types")
    try await setValueAsync(
      typesRef,
      value: [
        "str": "hello-rtdb",
        "whole": 42,
        "frac": 3.5,
        "flag": true,
        "list": ["x", "y"],
        "nested": ["inner": 7],
        "stampedAt": ServerValue.timestamp(),
      ]
    )
    let typesSnap = try await getDataAsync(typesRef)
    let deepInnerSnap = typesSnap.childSnapshot(forPath: "nested/inner")
    let deepInnerValue = (deepInnerSnap.value as? NSNumber)?.intValue ?? -1
    let stampedRaw = typesSnap.childSnapshot(forPath: "stampedAt").value
    let stampedEpoch = (stampedRaw as? NSNumber)?.int64Value ?? 0

    let missingSnap = try await getDataAsync(runRef.child("missing_leaf"))

    let prioGroup = runRef.child("priority_items")
    let pSecond = prioGroup.child("item_second")
    let pFirst = prioGroup.child("item_first")
    let pThird = prioGroup.child("item_third")

    try await setValueAsync(pSecond, value: "second-by-set-priority")
    try await setPriorityAsync(pSecond, priority: 20)
    try await setValueWithPriorityAsync(pFirst, value: "first-with-priority", priority: 5)
    try await setValueWithPriorityAsync(
      pThird,
      value: "third-string-priority",
      priority: "zeta"
    )

    let pSecondSnap = try await getDataAsync(pSecond)
    let pFirstSnap = try await getDataAsync(pFirst)
    let pThirdSnap = try await getDataAsync(pThird)
    let prioGroupSnap = try await getDataAsync(prioGroup)
    let defaultPriorityOrderedValues = collectChildStrings(prioGroupSnap)
    let explicitPriorityOrderedSnap = try await getDataAsync(prioGroup.queryOrderedByPriority())
    let explicitPriorityOrderedValues = collectChildStrings(explicitPriorityOrderedSnap)

    let exportDict = pFirstSnap.valueInExportFormat() as? [String: Any]
    let exportHasValueAndPriority =
      (exportDict?[".value"] as? String) == "first-with-priority"
      && (exportDict?[".priority"] as? NSNumber)?.intValue == 5

    let existedBeforeSetNil = pThirdSnap.exists()
    try await setValueAsync(pThird, value: nil)
    let afterSetNilSnap = try await getDataAsync(pThird)

    let playersRef = runRef.child("players")
    try await setValueAsync(
      playersRef,
      value: [
        "p1": ["tier": "gold", "score": 10],
        "p2": ["tier": "silver", "score": 20],
        "p3": ["tier": "gold", "score": 30],
        "p4": ["tier": "bronze", "score": 40],
      ]
    )

    let byChildEqualGold = collectChildKeys(
      try await getDataAsync(
        playersRef.queryOrdered(byChild: "tier").queryEqual(toValue: "gold")
      )
    )
    let byChildEqualGoldKeyP3 = collectChildKeys(
      try await getDataAsync(
        playersRef.queryOrdered(byChild: "tier").queryEqual(toValue: "gold", childKey: "p3")
      )
    )
    let byChildScoreInclusiveRange = collectChildKeys(
      try await getDataAsync(
        playersRef
          .queryOrdered(byChild: "score")
          .queryStarting(atValue: 20)
          .queryEnding(atValue: 30)
      )
    )
    let byChildScoreExclusiveRange = collectChildKeys(
      try await getDataAsync(
        playersRef
          .queryOrdered(byChild: "score")
          .queryStarting(afterValue: 10)
          .queryEnding(beforeValue: 40)
      )
    )
    let byChildScoreFirst2 = collectChildKeys(
      try await getDataAsync(
        playersRef.queryOrdered(byChild: "score").queryLimited(toFirst: 2)
      )
    )
    let byChildScoreLast2 = collectChildKeys(
      try await getDataAsync(
        playersRef.queryOrdered(byChild: "score").queryLimited(toLast: 2)
      )
    )

    try await removeValueAsync(runRef)
    let removedRunSnap = try await getDataAsync(runRef)

    defaultDbRef?.goOffline()
    urlDbRef?.goOffline()
    if createdDefaultApp, let defaultApp = FirebaseApp.app() {
      await deleteAppAsync(defaultApp)
    }

    return [
      "defaultInstanceIdentical": defaultInstanceIdentical,
      "defaultRootMatchesDatabaseUrl": defaultRootMatchesDatabaseUrl,
      "urlInstanceIdentical": urlInstanceIdentical,
      "namedAppMatches": namedAppMatches,
      "namedDatabaseIdentical": namedDatabaseIdentical,
      "rootKeyIsNil": rootKeyIsNil,
      "rootParentIsNil": rootParentIsNil,
      "rootSelfUrlMatches": rootSelfUrlMatches,
      "rootUrlMatchesDatabaseUrl": rootUrlMatchesDatabaseUrl,
      "nestedKey": nestedKey,
      "nestedParentKey": nestedParentKey,
      "nestedGrandParentKey": nestedGrandParentKey,
      "nestedRootKeyIsNil": nestedRootKeyIsNil,
      "nestedRootUrlMatchesRoot": nestedRootUrlMatchesRoot,
      "nestedUrlSuffixMatches": nestedUrlSuffixMatches,
      "nestedDescriptionSuffixMatches": nestedDescriptionSuffixMatches,
      "fromUrlMatchesKeyAndUrl": fromUrlMatchesKeyAndUrl,
      "pushKeyLength": pushKeyLength,
      "pushKeysLexicographicallyMonotonic": pushKeysLexicographicallyMonotonic,
      "pushOrderedValues": pushOrderedValues,
      "stringValueKind": describeSnapshotValueKind(typesSnap.childSnapshot(forPath: "str").value),
      "integralValueKind": describeSnapshotValueKind(
        typesSnap.childSnapshot(forPath: "whole").value
      ),
      "integralValueEquals42":
        (typesSnap.childSnapshot(forPath: "whole").value as? NSNumber)?.intValue == 42,
      "floatingValueKind": describeSnapshotValueKind(
        typesSnap.childSnapshot(forPath: "frac").value
      ),
      "booleanValueKind": describeSnapshotValueKind(
        typesSnap.childSnapshot(forPath: "flag").value
      ),
      "arrayValueKind": describeSnapshotValueKind(typesSnap.childSnapshot(forPath: "list").value),
      "dictionaryValueKind": describeSnapshotValueKind(
        typesSnap.childSnapshot(forPath: "nested").value
      ),
      "hasChildNested": typesSnap.hasChild("nested"),
      "hasChildDeepNestedInner": typesSnap.hasChild("nested/inner"),
      "hasChildMissing": typesSnap.hasChild("nonexistent"),
      "hasChildrenTrue": typesSnap.hasChildren(),
      "deepChildSnapshotInnerValue": deepInnerValue,
      "missingSnapshotExists": missingSnap.exists(),
      "missingSnapshotValueKind": describeSnapshotValueKind(missingSnap.value),
      "missingSnapshotHasChildren": missingSnap.hasChildren(),
      "missingSnapshotChildrenCount": Int(missingSnap.childrenCount),
      "missingSnapshotPriorityKind": describeSnapshotValueKind(missingSnap.priority),
      "serverTimestampValueKind": describeSnapshotValueKind(stampedRaw),
      "serverTimestampPlausibleEpochMs":
        stampedEpoch >= 1_700_000_000_000 && stampedEpoch < 4_102_444_800_000,
      "setPriorityPreservedValue": (pSecondSnap.value as? String) ?? "",
      "setPriorityNumericValue": (pSecondSnap.priority as? NSNumber)?.intValue ?? -1,
      "setPriorityNumericKind": describeSnapshotValueKind(pSecondSnap.priority),
      "setValueWithNumericPriority": (pFirstSnap.priority as? NSNumber)?.intValue ?? -1,
      "setValueWithStringPriority": (pThirdSnap.priority as? String) ?? "",
      "setValueWithStringPriorityKind": describeSnapshotValueKind(pThirdSnap.priority),
      "exportFormatHasValueAndPriority": exportHasValueAndPriority,
      "defaultPriorityOrderedValues": defaultPriorityOrderedValues,
      "explicitPriorityOrderedValues": explicitPriorityOrderedValues,
      "existedBeforeSetNil": existedBeforeSetNil,
      "existsAfterSetNil": afterSetNilSnap.exists(),
      "valueKindAfterSetNil": describeSnapshotValueKind(afterSetNilSnap.value),
      "priorityKindAfterSetNil": describeSnapshotValueKind(afterSetNilSnap.priority),
      "orderByChildEqualToGold": byChildEqualGold,
      "orderByChildEqualToGoldWithKeyP3": byChildEqualGoldKeyP3,
      "orderByChildScoreInclusiveRange20To30": byChildScoreInclusiveRange,
      "orderByChildScoreExclusiveRangeAfter10Before40": byChildScoreExclusiveRange,
      "orderByChildScoreLimitToFirst2": byChildScoreFirst2,
      "orderByChildScoreLimitToLast2": byChildScoreLast2,
      "cleanupRemovedRunNode": !removedRunSnap.exists(),
    ]
  } catch {
    try? await removeValueAsync(runRef)
    defaultDbRef?.goOffline()
    urlDbRef?.goOffline()
    if createdDefaultApp, let defaultApp = FirebaseApp.app() {
      await deleteAppAsync(defaultApp)
    }
    throw error
  }
}
