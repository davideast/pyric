import Foundation

extension FirestoreOfflineProjection {
    static func applyQueryConstraints(
        target: TargetDescriptor,
        candidates: [(path: String, doc: ProjectedOfflineDoc)]
    ) -> [(path: String, doc: ProjectedOfflineDoc)] {
        guard case .query(let sourceBox, let topConstraints) = target else {
            return candidates
        }
        var constraints: [QueryConstraintDescriptor] = []
        collectConstraints(from: sourceBox.value, into: &constraints)
        constraints.append(contentsOf: topConstraints)
        if constraints.isEmpty {
            return candidates
        }

        var filters: [QueryConstraintDescriptor] = []
        var orders: [(segments: [String], descending: Bool)] = []
        var limitCount: Int?
        var limitToLast = false
        var startCursor: (values: [AnySendable], inclusive: Bool)?
        var endCursor: (values: [AnySendable], inclusive: Bool)?

        for constraint in constraints {
            switch constraint {
            case .where, .and, .or:
                filters.append(constraint)
            case .orderBy(let field, let fieldSegments, let direction):
                let segs = fieldSegments ?? splitFieldPath(field)
                orders.append((segments: segs, descending: direction == "desc"))
            case .limit(let n):
                limitCount = n
                limitToLast = false
            case .limitToLast(let n):
                limitCount = n
                limitToLast = true
            case .startAt(let values, _):
                startCursor = (values: values, inclusive: true)
            case .startAfter(let values, _):
                startCursor = (values: values, inclusive: false)
            case .endAt(let values, _):
                endCursor = (values: values, inclusive: true)
            case .endBefore(let values, _):
                endCursor = (values: values, inclusive: false)
            }
        }

        let normalized = QueryCompiler.computeNormalizedOrders(from: constraints)
        let effectiveOrders: [(segments: [String], descending: Bool)] = normalized.map {
            (segments: $0.segments, descending: $0.direction == "desc")
        }

        var result = candidates.filter { entry in
            for clause in orders where clause.segments != ["__name__"] {
                if fieldValue(for: clause.segments, path: entry.path, fields: entry.doc.encodedFields) == nil {
                    return false
                }
            }
            return filters.allSatisfy { matchesFilter($0, path: entry.path, fields: entry.doc.encodedFields) }
        }

        result.sort { lhs, rhs in
            compareEntries(lhs, rhs, orders: effectiveOrders) < 0
        }

        if let startCursor {
            result = result.filter { entry in
                let cmp = compareEntryToCursor(entry, cursor: startCursor.values, orders: effectiveOrders)
                return startCursor.inclusive ? (cmp >= 0) : (cmp > 0)
            }
        }
        if let endCursor {
            result = result.filter { entry in
                let cmp = compareEntryToCursor(entry, cursor: endCursor.values, orders: effectiveOrders)
                return endCursor.inclusive ? (cmp <= 0) : (cmp < 0)
            }
        }
        if let limitCount, limitCount >= 0, result.count > limitCount {
            if limitToLast {
                result = Array(result.suffix(limitCount))
            } else {
                result = Array(result.prefix(limitCount))
            }
        }
        return result
    }

    private static func collectConstraints(from target: TargetDescriptor, into out: inout [QueryConstraintDescriptor]) {
        if case .query(let inner, let list) = target {
            collectConstraints(from: inner.value, into: &out)
            out.append(contentsOf: list)
        }
    }

    private static func fieldValue(
        for segments: [String],
        path: String,
        fields: [String: AnySendable]?
    ) -> AnySendable? {
        if segments == ["__name__"] {
            let docId = path.split(separator: "/").last.map(String.init) ?? path
            return .string(docId)
        }
        return readField(in: fields, segments: segments)
    }

    private static func matchesFilter(
        _ filter: QueryConstraintDescriptor,
        path: String,
        fields: [String: AnySendable]?
    ) -> Bool {
        switch filter {
        case .and(let children):
            return children.allSatisfy { matchesFilter($0, path: path, fields: fields) }
        case .or(let children):
            return children.contains { matchesFilter($0, path: path, fields: fields) }
        case .where(let field, let fieldSegments, let op, let target):
            let segments = fieldSegments ?? splitFieldPath(field)
            if segments == ["__name__"] {
                return matchesDocumentKey(path: path, op: op, target: target)
            }
            guard let actual = fieldValue(for: segments, path: path, fields: fields) else {
                return false
            }
            switch op {
            case "==":
                return wireValuesEqual(actual, target)
            case "!=":
                return !wireValuesEqual(actual, target)
            case "<":
                return sameComparableDomain(actual, target) && compareWireValues(actual, target) < 0
            case "<=":
                return sameComparableDomain(actual, target) && compareWireValues(actual, target) <= 0
            case ">":
                return sameComparableDomain(actual, target) && compareWireValues(actual, target) > 0
            case ">=":
                return sameComparableDomain(actual, target) && compareWireValues(actual, target) >= 0
            case "array-contains":
                guard let arr = actual.arrayValue else { return false }
                return arr.contains { wireValuesEqual($0, target) }
            case "in":
                guard let list = target.arrayValue else { return false }
                return list.contains { wireValuesEqual(actual, $0) }
            case "not-in":
                guard let list = target.arrayValue else { return false }
                return !list.contains { wireValuesEqual(actual, $0) }
            case "array-contains-any":
                guard let arr = actual.arrayValue, let list = target.arrayValue else { return false }
                return arr.contains { item in list.contains { wireValuesEqual(item, $0) } }
            default:
                return false
            }
        default:
            return true
        }
    }

    private static func compareKeyTarget(path: String, target: AnySendable) -> Int? {
        if let refPath = target.dictionaryValue?["path"]?.stringValue,
           target.dictionaryValue?["__type"]?.stringValue == "reference" {
            return comparePathStrings(path, refPath)
        }
        if let strTarget = target.stringValue {
            if strTarget.contains("/") {
                return comparePathStrings(path, strTarget)
            }
            let docId = path.split(separator: "/").last.map(String.init) ?? path
            return docId == strTarget ? 0 : (docId < strTarget ? -1 : 1)
        }
        return nil
    }

    private static func matchesDocumentKey(path: String, op: String, target: AnySendable) -> Bool {
        switch op {
        case "==":
            return compareKeyTarget(path: path, target: target) == 0
        case "!=":
            guard let cmp = compareKeyTarget(path: path, target: target) else { return true }
            return cmp != 0
        case "<":
            guard let cmp = compareKeyTarget(path: path, target: target) else { return false }
            return cmp < 0
        case "<=":
            guard let cmp = compareKeyTarget(path: path, target: target) else { return false }
            return cmp <= 0
        case ">":
            guard let cmp = compareKeyTarget(path: path, target: target) else { return false }
            return cmp > 0
        case ">=":
            guard let cmp = compareKeyTarget(path: path, target: target) else { return false }
            return cmp >= 0
        case "in":
            guard let list = target.arrayValue else { return false }
            return list.contains { compareKeyTarget(path: path, target: $0) == 0 }
        case "not-in":
            guard let list = target.arrayValue else { return false }
            return !list.contains { compareKeyTarget(path: path, target: $0) == 0 }
        default:
            return false
        }
    }

    private static func comparePathStrings(_ lhs: String, _ rhs: String) -> Int {
        let lSegs = lhs.split(separator: "/").map(String.init)
        let rSegs = rhs.split(separator: "/").map(String.init)
        for idx in 0..<min(lSegs.count, rSegs.count) where lSegs[idx] != rSegs[idx] {
            return lSegs[idx] < rSegs[idx] ? -1 : 1
        }
        return lSegs.count == rSegs.count ? 0 : (lSegs.count < rSegs.count ? -1 : 1)
    }

    private static func compareEntries(
        _ lhs: (path: String, doc: ProjectedOfflineDoc),
        _ rhs: (path: String, doc: ProjectedOfflineDoc),
        orders: [(segments: [String], descending: Bool)]
    ) -> Int {
        for clause in orders {
            let cmp: Int
            if clause.segments == ["__name__"] {
                cmp = comparePathStrings(lhs.path, rhs.path)
            } else {
                let lv = fieldValue(for: clause.segments, path: lhs.path, fields: lhs.doc.encodedFields) ?? .null
                let rv = fieldValue(for: clause.segments, path: rhs.path, fields: rhs.doc.encodedFields) ?? .null
                cmp = compareWireValues(lv, rv)
            }
            if cmp != 0 {
                return clause.descending ? -cmp : cmp
            }
        }
        return 0
    }

    private static func compareEntryToCursor(
        _ entry: (path: String, doc: ProjectedOfflineDoc),
        cursor: [AnySendable],
        orders: [(segments: [String], descending: Bool)]
    ) -> Int {
        for (idx, cursorVal) in cursor.enumerated() where idx < orders.count {
            let clause = orders[idx]
            let cmp: Int
            if clause.segments == ["__name__"] {
                if let refPath = cursorVal.dictionaryValue?["path"]?.stringValue,
                   cursorVal.dictionaryValue?["__type"]?.stringValue == "reference" {
                    cmp = comparePathStrings(entry.path, refPath)
                } else if let strCursor = cursorVal.stringValue {
                    if strCursor.contains("/") {
                        cmp = comparePathStrings(entry.path, strCursor)
                    } else {
                        let docId = entry.path.split(separator: "/").last.map(String.init) ?? entry.path
                        cmp = docId == strCursor ? 0 : (docId < strCursor ? -1 : 1)
                    }
                } else {
                    cmp = 0
                }
            } else {
                let actual = fieldValue(for: clause.segments, path: entry.path, fields: entry.doc.encodedFields) ?? .null
                cmp = compareWireValues(actual, cursorVal)
            }
            if cmp != 0 {
                return clause.descending ? -cmp : cmp
            }
        }
        return 0
    }

    private static func typeRank(_ val: AnySendable) -> Int {
        switch val {
        case .null: return 0
        case .bool: return 1
        case .int, .double: return 2
        case .string: return 4
        case .array: return 8
        case .dictionary(let dict):
            let marker = dict["__type"]?.stringValue ?? dict["type"]?.stringValue
            switch marker {
            case "number": return 2
            case "timestamp", "firestore/timestamp/1.0": return 3
            case "bytes", "firestore/bytes/1.0": return 5
            case "reference": return 6
            case "latlng", "firestore/geoPoint/1.0": return 7
            default: return 9
            }
        }
    }

    private static func sameComparableDomain(_ lhs: AnySendable, _ rhs: AnySendable) -> Bool {
        typeRank(lhs) == typeRank(rhs)
    }

    static func wireValuesEqual(_ lhs: AnySendable, _ rhs: AnySendable) -> Bool {
        if typeRank(lhs) != typeRank(rhs) { return false }
        if let ln = numericDouble(lhs), let rn = numericDouble(rhs) {
            if ln.isNaN || rn.isNaN { return false }
            return ln == rn
        }
        return compareWireValues(lhs, rhs) == 0
    }

    private static func numericDouble(_ val: AnySendable) -> Double? {
        switch val {
        case .int(let i): return Double(i)
        case .double(let d): return d
        case .dictionary(let dict) where dict["__type"]?.stringValue == "number":
            switch dict["value"]?.stringValue {
            case "NaN": return .nan
            case "Infinity": return .infinity
            case "-Infinity": return -.infinity
            case "-0": return -0.0
            default: return nil
            }
        default: return nil
        }
    }

    private static func compareWireValues(_ lhs: AnySendable, _ rhs: AnySendable) -> Int {
        let lr = typeRank(lhs)
        let rr = typeRank(rhs)
        if lr != rr { return lr < rr ? -1 : 1 }
        switch lr {
        case 0:
            return 0
        case 1:
            let lb = lhs.boolValue ?? false
            let rb = rhs.boolValue ?? false
            return lb == rb ? 0 : (lb ? 1 : -1)
        case 2:
            let ld = numericDouble(lhs) ?? 0
            let rd = numericDouble(rhs) ?? 0
            if ld.isNaN && rd.isNaN { return 0 }
            if ld.isNaN { return -1 }
            if rd.isNaN { return 1 }
            return ld == rd ? 0 : (ld < rd ? -1 : 1)
        case 3:
            let ls = lhs["seconds"]?.intValue ?? 0
            let rs = rhs["seconds"]?.intValue ?? 0
            if ls != rs { return ls < rs ? -1 : 1 }
            let ln = lhs["nanos"]?.intValue ?? lhs["nanoseconds"]?.intValue ?? 0
            let rn = rhs["nanos"]?.intValue ?? rhs["nanoseconds"]?.intValue ?? 0
            return ln == rn ? 0 : (ln < rn ? -1 : 1)
        case 4:
            let ls = lhs.stringValue ?? ""
            let rs = rhs.stringValue ?? ""
            return ls == rs ? 0 : (ls < rs ? -1 : 1)
        case 5:
            let ls = lhs["base64"]?.stringValue ?? lhs["bytes"]?.stringValue ?? ""
            let rs = rhs["base64"]?.stringValue ?? rhs["bytes"]?.stringValue ?? ""
            return ls == rs ? 0 : (ls < rs ? -1 : 1)
        case 6:
            let ls = lhs["path"]?.stringValue ?? ""
            let rs = rhs["path"]?.stringValue ?? ""
            return ls == rs ? 0 : (ls < rs ? -1 : 1)
        case 7:
            let llat = lhs["lat"]?.doubleValue ?? lhs["latitude"]?.doubleValue ?? 0
            let rlat = rhs["lat"]?.doubleValue ?? rhs["latitude"]?.doubleValue ?? 0
            if llat != rlat { return llat < rlat ? -1 : 1 }
            let llng = lhs["lng"]?.doubleValue ?? lhs["longitude"]?.doubleValue ?? 0
            let rlng = rhs["lng"]?.doubleValue ?? rhs["longitude"]?.doubleValue ?? 0
            return llng == rlng ? 0 : (llng < rlng ? -1 : 1)
        case 8:
            let la = lhs.arrayValue ?? []
            let ra = rhs.arrayValue ?? []
            for idx in 0..<min(la.count, ra.count) {
                let cmp = compareWireValues(la[idx], ra[idx])
                if cmp != 0 { return cmp }
            }
            return la.count == ra.count ? 0 : (la.count < ra.count ? -1 : 1)
        default:
            let ld = lhs.dictionaryValue ?? [:]
            let rd = rhs.dictionaryValue ?? [:]
            let lKeys = ld.keys.sorted()
            let rKeys = rd.keys.sorted()
            for idx in 0..<min(lKeys.count, rKeys.count) {
                if lKeys[idx] != rKeys[idx] { return lKeys[idx] < rKeys[idx] ? -1 : 1 }
                let cmp = compareWireValues(ld[lKeys[idx]] ?? .null, rd[rKeys[idx]] ?? .null)
                if cmp != 0 { return cmp }
            }
            return lKeys.count == rKeys.count ? 0 : (lKeys.count < rKeys.count ? -1 : 1)
        }
    }
}
