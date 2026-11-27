import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import 'storage_http_client.dart';

/// Web stub rejecting `dart:io` [HttpClient] byte-route transfers cleanly.
Future<StorageRawHttpResponse> performStorageHttpRequest({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  Uint8List? body,
  void Function(StorageCancelableHttpHandle handle)? onHandleCreated,
  void Function()? onHandleClosed,
}) async {
  throw FirebaseException(
    plugin: 'firebase_storage',
    code: 'unimplemented',
    message:
        'HTTP byte-route Storage transfers require dart:io and are unsupported on Web.',
  );
}
