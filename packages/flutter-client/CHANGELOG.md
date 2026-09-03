## 0.1.0

- Initial release of `pyric_firestore`.
- Pure-Dart `FirebaseFirestorePlatform` implementation routing calls to Pyric's local sandbox bridge.
- Document reference CRUD (`get`, `set`, `update`, `delete`).
- Query constraint compilation (`where`, `whereFilter`, `orderBy`, `limit`, cursors).
- Real-time snapshot streams (`snapshots()`) for documents and queries.
- Support for `FieldValue` sentinels (`serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`).
- Atomic batch operations (`WriteBatch`) and transaction platform hooks.
