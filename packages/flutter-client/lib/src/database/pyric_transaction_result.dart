import 'dart:async';

import 'pyric_data_snapshot.dart';

/// Encapsulates the data and priority of a node during an optimistic concurrency transaction.
class PyricMutableData {
  /// The key name of the location targeted by the transaction.
  final String? key;

  /// Mutable value of the node. Set this property to update the value written by the transaction.
  Object? value;

  /// Mutable priority of the node.
  Object? priority;

  PyricMutableData({
    required this.key,
    this.value,
    this.priority,
  });
}

/// Type alias conforming to `firebase_database` naming.
typedef MutableData = PyricMutableData;

/// Outcome returned by a transaction handler function.
class PyricTransactionHandlerResult {
  final bool aborted;
  final PyricMutableData? mutableData;

  const PyricTransactionHandlerResult._({
    required this.aborted,
    this.mutableData,
  });

  /// Indicates the transaction should commit the modified [mutableData].
  factory PyricTransactionHandlerResult.success(PyricMutableData mutableData) =>
      PyricTransactionHandlerResult._(aborted: false, mutableData: mutableData);

  /// Indicates the transaction should abort without writing changes.
  factory PyricTransactionHandlerResult.abort() =>
      const PyricTransactionHandlerResult._(aborted: true);
}

/// Helper class for returning transaction outcomes in `runTransaction` handlers.
class Transaction {
  const Transaction._();

  /// Commits the modified [mutableData] to the Realtime Database.
  static PyricTransactionHandlerResult success(PyricMutableData mutableData) =>
      PyricTransactionHandlerResult.success(mutableData);

  /// Aborts the transaction without applying any writes.
  static PyricTransactionHandlerResult abort() =>
      PyricTransactionHandlerResult.abort();
}

/// Handler function executed by `DatabaseReference.runTransaction`.
typedef PyricTransactionHandler = FutureOr<PyricTransactionHandlerResult>
    Function(PyricMutableData mutableData);

/// Type alias conforming to `firebase_database` naming.
typedef TransactionHandler = PyricTransactionHandler;

/// Final result returned after `DatabaseReference.runTransaction` completes.
class PyricTransactionResult {
  /// True if the transaction committed successfully; false if aborted.
  final bool committed;

  /// DataSnapshot reflecting the final node state after the transaction.
  final PyricDataSnapshot snapshot;

  const PyricTransactionResult({
    required this.committed,
    required this.snapshot,
  });
}

/// Type alias conforming to `firebase_database` naming.
typedef TransactionResult = PyricTransactionResult;
