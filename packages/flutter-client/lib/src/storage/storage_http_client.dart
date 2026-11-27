import 'dart:typed_data';

import 'storage_http_client_stub.dart'
    if (dart.library.io) 'storage_http_client_io.dart' as impl;

/// Raw HTTP status code and buffered bytes returned by a Storage byte-route request.
class StorageRawHttpResponse {
  final int statusCode;
  final Uint8List body;

  const StorageRawHttpResponse({
    required this.statusCode,
    required this.body,
  });
}

/// Handle allowing an in-flight Storage HTTP byte-route request to be aborted on cancel.
abstract interface class StorageCancelableHttpHandle {
  void abort();
}

/// Executes a Storage HTTP byte-route request using `dart:io` on IO platforms.
Future<StorageRawHttpResponse> performStorageHttpRequest({
  required String method,
  required Uri uri,
  required Map<String, String> headers,
  Uint8List? body,
  void Function(StorageCancelableHttpHandle handle)? onHandleCreated,
  void Function()? onHandleClosed,
}) {
  return impl.performStorageHttpRequest(
    method: method,
    uri: uri,
    headers: headers,
    body: body,
    onHandleCreated: onHandleCreated,
    onHandleClosed: onHandleClosed,
  );
}
